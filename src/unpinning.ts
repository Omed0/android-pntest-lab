// ── HTTPToolkit unpinning suite integration ────────────────────────────────
//
// Wires https://github.com/httptoolkit/frida-interception-and-unpinning
// (vendored under scripts/unpinning/, fetched 2026-09-18) into `bun run.ts`
// as the default Frida script chain, replacing this project's earlier
// single-file scripts/ssl-unpinning.js. That suite covers far more real
// apps than a single hand-written script can: native connect/TLS hooks
// (BoringSSL-level, catches non-Java networking entirely), OkHttp/TrustKit/
// Appmattus pinning, Flutter's own bundled TLS stack, root/Magisk detection,
// AND an auto-detection "fallback" layer that patches unrecognized pinning
// failures on the fly and clearly logs whatever it still couldn't handle —
// see `!!! --- Unexpected TLS failure --- !!!` / `must be patched manually`
// in android-certificate-unpinning-fallback.js, which is exactly this
// project's "alert and log the user when it can't bypass something"
// requirement, upstream already built it.
//
// Frida's CLI concatenates every `-l <file>` into one shared script
// context in the order given — this is how the upstream README's own
// multi -l example works, and is why config.js (or our generated
// equivalent) must be first: everything after it reads its top-level
// `const CERT_PEM/PROXY_HOST/PROXY_PORT/DEBUG_MODE` declarations.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { log } from "./log.ts";
import { extractPrintableStrings } from "./secrets.ts";
import { probeProxyReachable } from "./proxy.ts";

const UNPINNING_DIR = "unpinning";

// ── Dynamic pinning-technique detection ───────────────────────────────────────
//
// The chain above is a fixed, static list — every app gets every hook,
// whether it needs it or not. This section makes the "which hook actually
// matters here" question app-specific: scan the app's own extracted APK
// tree for known pinning-library fingerprints and, when one isn't
// generically coverable by the vendored suite, generate a starting-point
// custom hook under scripts/custom/<pkg>.js instead of silently doing
// nothing and leaving the user to rediscover it by watching Burp stay empty.

export type PinningStatus = "covered" | "verify-manually" | "needs-custom";

export interface PinningSignature {
  label: string;
  evidence: string;
  status: PinningStatus;
}

interface SignatureRule {
  label: string;
  status: PinningStatus;
  needle: string | RegExp;
}

const DEX_SIGNATURES: SignatureRule[] = [
  // ── High-confidence library pinning ───────────────────────────────────────

  {
    label: "OkHttp CertificatePinner",
    status: "covered",
    needle: /(?:okhttp3|com\.squareup\.okhttp)[./]CertificatePinner/i,
  },

  {
    label: "TrustKit",
    status: "covered",
    needle: /datatheorem.*trustkit/i,
  },

  {
    label: "Appmattus Certificate Transparency / pinning",
    status: "needs-custom",
    needle: /appmattus.*certificatetransparency/i,
  },

  // ── Strong custom Java pinning indicators ─────────────────────────────────

  {
    label: "Custom X509TrustManager",
    status: "needs-custom",
    needle: /X509TrustManager/i,
  },

  {
    label: "Custom checkServerTrusted implementation",
    status: "needs-custom",
    needle: /checkServerTrusted/i,
  },

  {
    label: "HostnameVerifier",
    status: "needs-custom",
    needle: /HostnameVerifier/i,
  },

  // ── Android Network Security Config ───────────────────────────────────────

  {
    label: "Network Security Config pin-set",
    status: "covered",
    needle: /pin-set/i,
  },

  {
    label: "Certificate digest reference",
    status: "needs-custom",
    needle: /sha256\/[A-Za-z0-9+/=]{20,}/i,
  },

  // ── Flutter / cross-platform ──────────────────────────────────────────────

  {
    label: "Flutter http_certificate_pinning",
    status: "covered",
    needle: /http[_-]?certificate[_-]?pinning/i,
  },

  {
    label: "Flutter ssl_pinning_plugin",
    status: "covered",
    needle: /ssl[_-]?pinning[_-]?plugin/i,
  },

  {
    label: "Cronet",
    status: "verify-manually",
    needle: /org\.chromium\.net\.CronetEngine|CronetEngine/i,
  },

  // ── Explicit pinning terminology ─────────────────────────────────────────

  {
    label: "Certificate pinning",
    status: "needs-custom",
    needle: /certificate.?pinning|cert.?pinning|public.?key.?pinning/i,
  },

  {
    label: "Pinned certificate",
    status: "needs-custom",
    needle: /pinnedCertificate|pinnedCertificates|pinCertificates/i,
  },

  {
    label: "Certificate hash comparison",
    status: "needs-custom",
    needle: /MessageDigest.*SHA-256|SHA-256.*certificate|digest.*certificate/i,
  },

  {
    label: "Public key hash comparison",
    status: "needs-custom",
    needle: /public.?key.*hash|publicKey.*digest|pubkey.*sha256/i,
  },
];

/** Read a directory tree's file list (relative paths), skipping nothing — extract.ts already limits size via what it extracts. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

/**
 * Scan an extracted APK tree for known pinning-technique fingerprints.
 * Looks at classes*.dex (via raw string extraction — no disassembler needed,
 * the class/method names pinning libraries use show up as plain strings in
 * the dex string pool) and, if present, network_security_config.xml and
 * AndroidManifest.xml for a static <pin-set>.
 */
export function detectPinningSignatures(
  extractedDir: string,
): PinningSignature[] {
  const found: PinningSignature[] = [];
  if (!existsSync(extractedDir)) return found;

  const files = walkFiles(extractedDir);
  const dexFiles = files.filter((f) => /classes\d*\.dex$/i.test(f));
  for (const dexFile of dexFiles) {
    const strings = extractPrintableStrings(readFileSync(dexFile));
    const haystack = strings.join("\n");
    for (const rule of DEX_SIGNATURES) {
      const matched =
        typeof rule.needle === "string"
          ? haystack.includes(rule.needle)
          : rule.needle.test(haystack);
      if (matched && !found.some((f) => f.label === rule.label)) {
        found.push({
          label: rule.label,
          status: rule.status,
          evidence: `found in ${dexFile.slice(extractedDir.length + 1)}`,
        });
      }
    }
  }

  // network_security_config.xml, like every res/**/*.xml in a raw-extracted
  // APK, is compiled binary AXML, not text — tag/attribute names live in a
  // binary string pool, so there is no literal "<pin-set>" to regex for.
  // The string pool still holds plain-text copies of tag/attribute-value
  // strings (confirmed via extractPrintableStrings' UTF-16LE pass), so
  // presence detection works via substring search; exact pin digests need a
  // real AXML decoder (aapt2 dump xmltree / apktool / jadx -d without
  // --no-res) which this lab doesn't force a dependency on — point the user
  // there instead of guessing.
  const nscPath = files.find((f) => /network_security_config\.xml$/i.test(f));
  if (nscPath) {
    const strings = extractPrintableStrings(readFileSync(nscPath));
    if (strings.some((s) => /pin-set/i.test(s))) {
      found.push({
        label: "Network Security Config <pin-set>",
        status: "covered",
        evidence: `${nscPath.slice(extractedDir.length + 1)} — run \`aapt2 dump xmltree <apk> --file res/xml/network_security_config.xml\` (or decompile with jadx/apktool) for the exact pinned digests`,
      });
    }
  }

  return found;
}

/**
 * Generate an automatic per-app dynamic Frida hook.
 *
 * This file is intentionally separate from scripts/custom/<pkg>.js:
 *   <pkg>.auto.js -> generated and safe to overwrite on every extract
 *   <pkg>.js     -> optional hand-written hook, never overwritten
 *
 * The generated hook:
 * - hooks common Java pinning APIs
 * - avoids replacing process-wide SSLContext/HostnameVerifier state
 * - hooks OkHttp CertificatePinner
 * - handles WebView SSL errors
 * - dynamically scans loaded application/library classes
 * - catches classes loaded after startup
 *
 * This is a heuristic dynamic layer, not a guarantee that arbitrary native
 * or heavily protected pinning can always be bypassed.
 */
export function generateCustomHookStub(
  labRoot: string,
  pkg: string,
  signatures: PinningSignature[],
): string {
  const customDir = join(labRoot, "scripts", "custom");
  const customPath = join(customDir, `${pkg}.auto.js`);

  mkdirSync(customDir, { recursive: true });

  const detected = signatures.length
    ? signatures
        .map(
          (s) =>
            `//   - ${s.label} [${s.status}] — ${s.evidence.replace(/\r?\n/g, " ")}`,
        )
        .join("\n")
    : "//   - No static pinning fingerprint matched; dynamic runtime discovery enabled.";

  const pkgLiteral = JSON.stringify(pkg);

  const script = `// AUTO-GENERATED BY ANDROID-PENTEST-LAB
// Target package: ${pkg}
// Do not edit this file manually.
// It is regenerated by \`bun run extract\`.
//
// Detected during extraction:
// ${detected}

'use strict';

const TARGET_PACKAGE = ${pkgLiteral};

const hookedMethods = new Set();

function log(msg) {
  console.log('[AUTO-UNPIN] ' + msg);
}

function typeName(t) {
  if (!t) return '';
  return String(t.className || t.name || '');
}

function isBlockedSystemClass(name) {
  return /^(java|javax|android|androidx|dalvik|sun|kotlin|kotlinx|com\\.android)\\./.test(name);
}

function looksInterestingClass(name) {
  if (isBlockedSystemClass(name)) return false;

  if (name.indexOf(TARGET_PACKAGE) === 0) {
    return true;
  }

  return /(trust|pinning|pinner|certificate|cert|tls|ssl|hostname|verifier|security)/i.test(
    name,
  );
}

function safeUse(className) {
  try {
    return Java.use(className);
  } catch (_) {
    return null;
  }
}

function hookOkHttpCertificatePinner(className) {
  try {
    const CertificatePinner = safeUse(className);
    if (!CertificatePinner || !CertificatePinner.check) return;

    for (const overload of CertificatePinner.check.overloads) {
      const key =
        className +
        '.check(' +
        (overload.argumentTypes || []).map(typeName).join(',') +
        ')';

      if (hookedMethods.has(key)) continue;

      hookedMethods.add(key);

      overload.implementation = function () {
        log(className + '.check -> bypass');
        return;
      };
    }

    log('Hooked ' + className + '.CertificatePinner.check');
  } catch (e) {
    log(className + ' hook failed: ' + e);
  }
}

function hookWebViewSslErrors() {
  try {
    const WebViewClient = Java.use('android.webkit.WebViewClient');

    if (!WebViewClient.onReceivedSslError) return;

    for (const overload of WebViewClient.onReceivedSslError.overloads) {
      const args = overload.argumentTypes || [];

      if (args.length !== 3) continue;

      const key =
        'WebViewClient.onReceivedSslError/' +
        args.map(typeName).join(',');

      if (hookedMethods.has(key)) continue;

      hookedMethods.add(key);

      overload.implementation = function (_view, handler, _error) {
        try {
          log('WebView onReceivedSslError -> proceed()');
          handler.proceed();
        } catch (e) {
          log('WebView proceed() failed: ' + e);
        }

        return;
      };
    }

    log('Hooked WebViewClient.onReceivedSslError');
  } catch (e) {
    log('WebView SSL error hook failed: ' + e);
  }
}

function hookLoadedClass(className) {
  if (!looksInterestingClass(className)) return;

  const C = safeUse(className);
  if (!C) return;

  try {
    if (C.checkServerTrusted) {
      for (const overload of C.checkServerTrusted.overloads) {
        const args = overload.argumentTypes || [];
        const ret = typeName(overload.returnType);

        const hasCertArray = args.some(function (a) {
          return typeName(a).indexOf('X509Certificate') !== -1;
        });

        if (!hasCertArray || ret !== 'void') continue;

        const key =
          className +
          '.checkServerTrusted(' +
          args.map(typeName).join(',') +
          ')';

        if (hookedMethods.has(key)) continue;

        hookedMethods.add(key);

        overload.implementation = function () {
          log(className + '.checkServerTrusted -> bypass');
          return;
        };
      }
    }
  } catch (_) {
    // Ignore classes that cannot be hooked.
  }

  try {
    if (C.verify) {
      for (const overload of C.verify.overloads) {
        const args = overload.argumentTypes || [];
        const ret = typeName(overload.returnType);

        if (args.length !== 2 || ret !== 'boolean') continue;

        const a0 = typeName(args[0]);
        const a1 = typeName(args[1]);

        const supported =
          (a0 === 'java.lang.String' &&
            a1 === 'javax.net.ssl.SSLSession') ||
          (a0 === 'java.lang.String' &&
            a1 === 'java.security.cert.X509Certificate');

        if (!supported) continue;

        const key =
          className +
          '.verify(' +
          args.map(typeName).join(',') +
          ')';

        if (hookedMethods.has(key)) continue;

        hookedMethods.add(key);

        overload.implementation = function () {
          log(className + '.verify -> true');
          return true;
        };
      }
    }
  } catch (_) {
    // Ignore classes that cannot be hooked.
  }
}

function scanLoadedClasses() {
  try {
    const classes = Java.enumerateLoadedClassesSync();

    for (const className of classes) {
      if (looksInterestingClass(className)) {
        hookLoadedClass(className);
      }
    }
  } catch (e) {
    log('Class enumeration failed: ' + e);
  }
}

Java.perform(function () {
  log('Dynamic app-specific pinning hook started for ' + TARGET_PACKAGE);
  log('Compatibility mode: no global SSLContext/HostnameVerifier replacement');

  // Keep the generated hook focused on app/library-specific pinning APIs.
  // The vendored HTTPToolkit suite already handles the platform TLS path;
  // replacing javax.net.ssl.SSLContext globally can interfere with apps that
  // construct their own TLS stacks and can cause startup/initialization exits.
  hookOkHttpCertificatePinner('okhttp3.CertificatePinner');
  hookOkHttpCertificatePinner('com.squareup.okhttp.CertificatePinner');
  hookWebViewSslErrors();

  scanLoadedClasses();

  // Catch libraries/classes loaded after startup.
  setInterval(function () {
    scanLoadedClasses();
  }, 2000);

  log('Dynamic pinning hook ready');
});
`;

  writeFileSync(customPath, script, "utf8");
  return customPath;
}

/**
 * config.js ships with real shared utility code below its config constants
 * (base64/PEM decoding, a module-load observer other scripts subscribe to)
 * that must NOT be reimplemented or dropped — so this substitutes just the
 * 4 top `const X = ...;` declarations in the real vendored file, in place,
 * and leaves everything else byte-for-byte as upstream shipped it.
 */
function renderConfig(
  templatePath: string,
  certPem: string,
  proxyHost: string,
  proxyPort: number,
  debugMode: boolean,
): string {
  let src = readFileSync(templatePath, "utf8");
  const escapedPem = certPem.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  src = src.replace(
    /const CERT_PEM = `[\s\S]*?`;/,
    `const CERT_PEM = \`${escapedPem}\`;`,
  );
  // Match BOTH quote styles — the vendored template uses double quotes.
  src = src.replace(
    /const PROXY_HOST = ['"].*?['"];/,
    `const PROXY_HOST = ${JSON.stringify(proxyHost)};`,
  );
  src = src.replace(
    /const PROXY_PORT = \d+;/,
    `const PROXY_PORT = ${proxyPort};`,
  );
  src = src.replace(
    /const DEBUG_MODE = (true|false);/,
    `const DEBUG_MODE = ${debugMode ? "true" : "false"};`,
  );
  return src;
}

/**
 * Build the ordered list of Frida `-l` script paths for the full HTTPToolkit
 * unpinning chain, generating a fresh config.generated.js from the real CA
 * + proxy settings this run is using. Returns null (with a clear warning)
 * if no proxy CA is available yet — the suite can't do anything useful
 * without one.
 *
 * If scripts/custom/<pkg>.js exists, it's appended as one more `-l` after
 * the whole suite — the documented place to drop a hand-written hook for an
 * app the generic + fallback layers still can't crack (mirroring what this
 * project's own now-retired scripts/ssl-unpinning.js used to hardcode
 * per-app, e.g. the Tarik-Althuraya SSLContext.init crash workaround).
 */
export async function buildUnpinningScriptChain(
  labRoot: string,
  proxyHost: string,
  proxyPort: number,
  debugMode: boolean,
  pkg?: string,
  proxyDisabled = false,
): Promise<string[] | null> {
  const scriptsDir = join(labRoot, "scripts", UNPINNING_DIR);
  const configTemplate = join(scriptsDir, "config.js");
  if (!existsSync(configTemplate)) {
    log.warn(
      `Unpinning suite not found under ${scriptsDir} — falling back to --frida-script if given.`,
    );
    return null;
  }

  const certPem = getProxyCertificatePem(labRoot);
  if (!certPem && !proxyDisabled) {
    log.warn(
      "No proxy CA available yet — the unpinning suite needs one to trust.\n" +
        "  Run `bun run init` first (it fetches/installs one automatically), or place a cert under cert/.",
    );
    return null;
  }

  // native-connect-hook.js below forces every raw connect() on ports
  // 80/443/8080/8443 to proxyHost:proxyPort, independently of the
  // device-global proxy setting. If nothing's listening there, the attached
  // app loses all connectivity the instant Frida loads it — with no sign of
  // why, since the failing connections happen inside the hook. Same loud
  // alert setDeviceProxy() prints, for the same reason; still proceeds,
  // since this project's users want traffic routed through their proxy, not
  // silently around it.
  if (!proxyDisabled && !(await probeProxyReachable(proxyHost, proxyPort))) {
    log.alert("PROXY NOT REACHABLE — this app will lose ALL network access", [
      `Frida's native-connect-hook is about to redirect this app's connections to ${proxyHost}:${proxyPort},`,
      "but nothing answered there from this machine. Start your proxy (bound to all interfaces),",
      "then rerun. Proceeding anyway — pass --no-proxy if you want this app to skip the redirect instead.",
    ]);
  }

  const configPath = join(scriptsDir, "config.generated.js");
  writeFileSync(
    configPath,
    renderConfig(configTemplate, certPem ?? "", proxyHost, proxyPort, debugMode),
    "utf8",
  );

  // --no-proxy means "don't force my traffic through a proxy" — that has
  // to cover BOTH mechanisms this project uses to do that, not just the
  // device-global `settings put global http_proxy` (src/proxy.ts). Without
  // this, an app attached with the default chain still got every raw
  // connect() on ports 80/443/8080/8443 redirected to burpHost:burpPort by
  // native-connect-hook.js, and its JVM/ConnectivityManager proxy forced
  // to the same address by android-proxy-override.js — independently of
  // --no-proxy, and independently of whether that address was reachable at
  // all. That's the confirmed root cause of apps losing all connectivity
  // even after --no-proxy was passed to `bun run.ts`. The rest of the
  // suite (pinning bypass, root-detection bypass) doesn't force a network
  // redirect and still loads either way.
  const chain = [
    configPath,
    ...(proxyDisabled ? [] : [join(scriptsDir, "native-connect-hook.js")]),
    join(scriptsDir, "native-tls-hook.js"),
    ...(proxyDisabled ? [] : [join(scriptsDir, "android", "android-proxy-override.js")]),
    join(scriptsDir, "android", "android-system-certificate-injection.js"),
    join(scriptsDir, "android", "android-certificate-unpinning.js"),
    join(scriptsDir, "android", "android-certificate-unpinning-fallback.js"),
    join(scriptsDir, "android", "android-disable-root-detection.js"),
    join(scriptsDir, "android", "android-pairip-bypass.js"),
    join(
      scriptsDir,
      "android",
      "android-disable-flutter-certificate-pinning.js",
    ),
  ].filter(existsSync);
  if (pkg) {
    const autoPath = join(labRoot, "scripts", "custom", `${pkg}.auto.js`);

    if (existsSync(autoPath)) {
      log.good(
        `Automatic per-app hook found: scripts/custom/${pkg}.auto.js — loading after the unpinning suite.`,
      );
      chain.push(autoPath);
    }

    // Manual hook remains supported and is loaded last.
    const manualPath = join(labRoot, "scripts", "custom", `${pkg}.js`);

    if (existsSync(manualPath)) {
      log.good(
        `Manual per-app hook found: scripts/custom/${pkg}.js — loading last.`,
      );
      chain.push(manualPath);
    }
  }

  return chain;
}

/**
 * Read the currently-available proxy CA (whatever findProxyCertificate()
 * would find — .cer/.crt/.der/.pem under cert/, or --proxy-cert) as PEM
 * text, converting from DER if needed. Returns null if no cert is
 * available yet or it isn't a readable X.509 certificate. Used to feed
 * CERT_PEM into the HTTPToolkit unpinning suite's generated config.js.
 */
function getProxyCertificatePem(labRoot: string): string | null {
  const pemPath = join(labRoot, "cert", "burp-ca.pem");

  if (!existsSync(pemPath)) {
    log.warn(`Burp CA PEM not found: ${pemPath}`);
    return null;
  }

  const pem = readFileSync(pemPath, "utf8").trim();

  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    log.warn(`Invalid Burp CA PEM: ${pemPath}`);
    return null;
  }

  if (!pem.includes("-----END CERTIFICATE-----")) {
    log.warn(`Invalid Burp CA PEM: ${pemPath}`);
    return null;
  }

  return pem;
}

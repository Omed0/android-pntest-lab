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

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { log } from "./log.ts";
import { getProxyCertificatePem } from "./proxy.ts";
import { extractPrintableStrings } from "./secrets.ts";

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
  { label: "OkHttp CertificatePinner", status: "covered", needle: "Lokhttp3/CertificatePinner;" },
  { label: "TrustKit", status: "covered", needle: "Lcom/datatheorem/android/trustkit/" },
  { label: "Appmattus CertificateTransparency/pinning", status: "needs-custom", needle: "Lcom/appmattus/certificatetransparency/" },
  { label: "Flutter http_certificate_pinning plugin", status: "verify-manually", needle: "Lcom/diefferson/http_certificate_pinning/" },
  { label: "Flutter ssl_pinning_plugin", status: "verify-manually", needle: /Lcom\/macif\/plugin\/sslpinningplugin\//i },
  { label: "Conscrypt custom TrustManager", status: "verify-manually", needle: "Lorg/conscrypt/" },
  { label: "Custom X509TrustManager implementation", status: "needs-custom", needle: /L[\w/$]+;->checkServerTrusted/ },
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
export function detectPinningSignatures(extractedDir: string): PinningSignature[] {
  const found: PinningSignature[] = [];
  if (!existsSync(extractedDir)) return found;

  const files = walkFiles(extractedDir);
  const dexFiles = files.filter(f => /classes\d*\.dex$/i.test(f));
  for (const dexFile of dexFiles) {
    const strings = extractPrintableStrings(readFileSync(dexFile));
    const haystack = strings.join("\n");
    for (const rule of DEX_SIGNATURES) {
      const matched = typeof rule.needle === "string"
        ? haystack.includes(rule.needle)
        : rule.needle.test(haystack);
      if (matched && !found.some(f => f.label === rule.label)) {
        found.push({ label: rule.label, status: rule.status, evidence: `found in ${dexFile.slice(extractedDir.length + 1)}` });
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
  const nscPath = files.find(f => /network_security_config\.xml$/i.test(f));
  if (nscPath) {
    const strings = extractPrintableStrings(readFileSync(nscPath));
    if (strings.some(s => /pin-set/i.test(s))) {
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
 * For every "needs-custom" signature, generate a starter stub in
 * scripts/custom/<pkg>.js documenting what was found — unless that file
 * already exists, in which case it's left alone (never overwrite a hand
 * edit). Returns the path if a new file was written, else null.
 */
export function generateCustomHookStub(labRoot: string, pkg: string, signatures: PinningSignature[]): string | null {
  const needsCustom = signatures.filter(s => s.status === "needs-custom");
  if (needsCustom.length === 0) return null;

  const customDir = join(labRoot, "scripts", "custom");
  const customPath = join(customDir, `${pkg}.js`);
  if (existsSync(customPath)) return null;

  mkdirSync(customDir, { recursive: true });
  const stub = `// Auto-generated starter hook for ${pkg}
// Generated by \`bun run extract\` because static analysis found pinning
// techniques the default HTTPToolkit suite (scripts/unpinning/) doesn't
// generically cover. Fill in the TODOs below, then re-run:
//   bun run.ts --package=${pkg}
//
// Detected:
${needsCustom.map(s => `//   - ${s.label} (${s.evidence})`).join("\n")}

Java.perform(() => {
${needsCustom.map(s => `  // TODO: hook the class/method backing "${s.label}" and force it to accept the connection.\n  // See scripts/unpinning/android/android-certificate-unpinning.js for the general pattern.`).join("\n\n")}
});
`;
  writeFileSync(customPath, stub, "utf8");
  return customPath;
}

/**
 * config.js ships with real shared utility code below its config constants
 * (base64/PEM decoding, a module-load observer other scripts subscribe to)
 * that must NOT be reimplemented or dropped — so this substitutes just the
 * 4 top `const X = ...;` declarations in the real vendored file, in place,
 * and leaves everything else byte-for-byte as upstream shipped it.
 */
function renderConfig(templatePath: string, certPem: string, proxyHost: string, proxyPort: number, debugMode: boolean): string {
  let src = readFileSync(templatePath, "utf8");
  const escapedPem = certPem.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  src = src.replace(/const CERT_PEM = `[\s\S]*?`;/, `const CERT_PEM = \`${escapedPem}\`;`);
  src = src.replace(/const PROXY_HOST = '.*?';/, `const PROXY_HOST = ${JSON.stringify(proxyHost)};`);
  src = src.replace(/const PROXY_PORT = \d+;/, `const PROXY_PORT = ${proxyPort};`);
  src = src.replace(/const DEBUG_MODE = (true|false);/, `const DEBUG_MODE = ${debugMode ? "true" : "false"};`);
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
export function buildUnpinningScriptChain(
  labRoot: string,
  proxyHost: string,
  proxyPort: number,
  debugMode: boolean,
  pkg?: string,
): string[] | null {
  const scriptsDir = join(labRoot, "scripts", UNPINNING_DIR);
  const configTemplate = join(scriptsDir, "config.js");
  if (!existsSync(configTemplate)) {
    log.warn(`Unpinning suite not found under ${scriptsDir} — falling back to --frida-script if given.`);
    return null;
  }

  const certPem = getProxyCertificatePem(labRoot);
  if (!certPem) {
    log.warn(
      "No proxy CA available yet — the unpinning suite needs one to trust.\n" +
        "  Run `bun run init` first (it fetches/installs one automatically), or place a cert under cert/.",
    );
    return null;
  }

  const configPath = join(scriptsDir, "config.generated.js");
  writeFileSync(configPath, renderConfig(configTemplate, certPem, proxyHost, proxyPort, debugMode), "utf8");

  const chain = [
    configPath,
    join(scriptsDir, "native-connect-hook.js"),
    join(scriptsDir, "native-tls-hook.js"),
    join(scriptsDir, "android", "android-proxy-override.js"),
    join(scriptsDir, "android", "android-system-certificate-injection.js"),
    join(scriptsDir, "android", "android-certificate-unpinning.js"),
    join(scriptsDir, "android", "android-certificate-unpinning-fallback.js"),
    join(scriptsDir, "android", "android-disable-root-detection.js"),
    join(scriptsDir, "android", "android-disable-flutter-certificate-pinning.js"),
  ].filter(existsSync);

  if (pkg) {
    const customPath = join(labRoot, "scripts", "custom", `${pkg}.js`);
    if (existsSync(customPath)) {
      log.good(`Custom per-app hook found: scripts/custom/${pkg}.js — loading after the unpinning suite.`);
      chain.push(customPath);
    }
  }

  return chain;
}

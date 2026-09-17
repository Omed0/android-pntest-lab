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

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "./log.ts";
import { getProxyCertificatePem } from "./proxy.ts";

const UNPINNING_DIR = "unpinning";

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

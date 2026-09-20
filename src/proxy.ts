// ── Proxy + CA certificate setup (Burp Suite by default, any other tool works) ─
//
// Shared by both `bun run init` (bootstrapLab() in src/lab.ts — sets this up
// once, device-wide, right after root/Frida are confirmed, so the lab is
// proxy-ready the moment init finishes) and `bun run.ts` (re-applies the same
// idempotent steps right before attaching Frida, in case the device was
// restarted or a different proxy config is wanted for this particular run).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { log } from "./log.ts";
import { run, which } from "./exec.ts";
import type { findAdb } from "./adb.ts";
import type { detectPlatform } from "./platform.ts";

// ── openssl availability ──────────────────────────────────────────────────────
//
// Every certificate check below shells out to openssl. Nothing in this
// project checks for it, documents it, or installs it — it's silently
// assumed to already be on PATH. Windows doesn't ship it by default (only
// via Git for Windows or a standalone install), so a genuinely fresh
// machine can be missing it entirely. Before this check existed, a missing
// openssl and a real "this file isn't actually a certificate" error
// produced byte-for-byte the same downstream message ("Burp CA is not a
// readable X.509 certificate") — run()'s ENOENT handling turns "command not
// found" into an ordinary {ok:false, stdout:""} result, indistinguishable
// from openssl running and finding nothing. Checked once and cached so a
// missing tool doesn't reprint the same warning on every call in one run
// (getProxyCertificatePem() alone can be called once per `bun run.ts`
// invocation's unpinning-chain build).
let opensslPathCache: string | null | undefined;
function opensslAvailable(): boolean {
  if (opensslPathCache === undefined) {
    opensslPathCache = which("openssl");
    if (!opensslPathCache) {
      log.warn(
        "openssl not found on PATH — needed to install/verify the proxy CA certificate.\n" +
        "  Install it (Git for Windows bundles one, usually at <git>\\usr\\bin\\openssl.exe, or install OpenSSL\n" +
        "  directly) and rerun `bun run init` / `bun run.ts`. Root, Frida, and both emulators are unaffected —\n" +
        "  only HTTPS interception via the proxy CA needs this.",
      );
    }
  }
  return opensslPathCache !== null;
}

interface ParsedCertificate {
  format: "DER" | "PEM";
  pem: string;
  hash: string;
}

/**
 * Single source of truth for "is this file a readable X.509 certificate,
 * and what is it" — replaces two previously-separate, inconsistent
 * implementations (one PEM-first returning null on failure, one DER-first
 * throwing on failure) that answered the same question differently.
 * Tries DER first (Burp's own native export format) then PEM. Never
 * throws — returns null on any failure, including openssl being absent.
 */
function readCertificate(certPath: string): ParsedCertificate | null {
  if (!opensslAvailable()) return null;
  for (const format of ["DER", "PEM"] as const) {
    const pemResult = run("openssl", ["x509", "-in", certPath, "-inform", format, "-outform", "PEM"]);
    if (!pemResult.ok || !pemResult.stdout.includes("BEGIN CERTIFICATE")) continue;
    const hashResult = run("openssl", ["x509", "-subject_hash_old", "-inform", format, "-in", certPath]);
    const hash = hashResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[0-9a-f]{8}$/i.test(line));
    if (!hash) continue;
    return { format, pem: pemResult.stdout.trim(), hash: hash.toLowerCase() };
  }
  return null;
}

/**
 * Configure the emulator's global HTTP/HTTPS proxy to point at the
 * configured listener (Burp by default; any proxy tool works the same way).
 * Uses `adb shell settings put global http_proxy host:port`.
 * The emulator's default gateway 10.0.2.2 reaches the host machine.
 */
export function setDeviceProxy(
  adb: ReturnType<typeof findAdb>,
  host: string,
  port: number,
  proxyTool: "burp" | "other",
): void {
  log.step("Proxy");
  log.info(`Setting device proxy → ${host}:${port}`);
  adb.shell(`settings put global http_proxy ${host}:${port}`);
  const val = adb.shell("settings get global http_proxy");
  if (val.includes(`${host}:${port}`)) {
    log.good(`Proxy set: ${host}:${port}`);
  } else {
    log.warn(`Proxy setting may not have taken effect (got: ${val})`);
  }
  if (proxyTool === "burp") {
    log.info(
      "  Reminder: make sure Burp Suite is listening on all interfaces (0.0.0.0)",
    );
    log.info(
      `  Burp > Proxy > Proxy Listeners > Binding address = All interfaces, port ${port}`,
    );
  } else {
    log.info(
      `  Reminder: make sure your proxy tool is listening on ${host}:${port} (all interfaces).`,
    );
  }
}

/**
 * Read the currently-available proxy CA (whatever findProxyCertificate()
 * would find — .cer/.crt/.der/.pem under cert/, or --proxy-cert) as PEM
 * text, converting from DER if needed. Returns null if no cert is
 * available yet or it isn't a readable X.509 certificate. Used to feed
 * CERT_PEM into the HTTPToolkit unpinning suite's generated config.js.
 */
export function getProxyCertificatePem(labRoot: string, requestedPath?: string): string | null {
  const certPath = findProxyCertificate(labRoot, requestedPath);
  if (!certPath) return null;
  return readCertificate(certPath)?.pem ?? null;
}

/**
 * Read back the device's current global HTTP/HTTPS proxy setting.
 * `adb shell settings get global http_proxy` prints "null" (not the string
 * "null" wrapped in anything special) when nothing is set.
 */
export function getDeviceProxy(adb: ReturnType<typeof findAdb>): string | null {
  const val = adb.shell("settings get global http_proxy").trim();
  return val && val !== "null" ? val : null;
}

/**
 * Clear the device's global HTTP/HTTPS proxy (`settings put global
 * http_proxy :0`, the standard way to reset it back to "no proxy" — an
 * empty string does not reliably clear it on every Android version, `:0`
 * does). Traffic goes direct again after this.
 */
export function clearDeviceProxy(adb: ReturnType<typeof findAdb>): void {
  log.step("Proxy");
  log.info("Clearing device proxy…");
  adb.shell("settings put global http_proxy :0");
  const val = getDeviceProxy(adb);
  if (val === null) {
    log.good("Proxy cleared — traffic goes direct.");
  } else {
    log.warn(`Proxy setting may not have cleared (got: ${val})`);
  }
}

export function findProxyCertificate(labRoot: string, requested?: string): string | null {
  if (requested) return existsSync(requested) ? requested : null;
  const certDir = join(labRoot, "cert");
  if (!existsSync(certDir)) return null;
  const name = readdirSync(certDir).find(
    (file) => !file.startsWith(".") && /\.(cer|crt|der|pem)$/i.test(file),
  );
  return name ? join(certDir, name) : null;
}

function downloadBurpCertificate(labRoot: string, host: string, port: number): string | null {
  const certDir = join(labRoot, "cert");
  const certPath = join(certDir, "burp-ca.cer");
  mkdirSync(certDir, { recursive: true });

  log.step("Burp CA certificate");
  if (existsSync(certPath) && statSync(certPath).size > 0) {
    log.good(`Burp CA already available: ${certPath}`);
    return certPath;
  }

  // This curl runs on the HOST (not inside the emulator), so it must use a
  // host-reachable address. `host` here is normally "10.0.2.2" — the
  // Android emulator's own alias for the host's loopback interface, valid
  // ONLY from inside the guest. The host itself can never reach "10.0.2.2"
  // (confirmed directly: it's not a real interface on the host machine at
  // all), so the auto-download silently failed every time this ran with
  // the default burpHost, regardless of whether Burp was even running.
  // Substitute 127.0.0.1 for exactly that one well-known alias; any other
  // host value (e.g. a LAN IP for a physical device) is already reachable
  // from both sides and is used as-is.
  const fetchHost = host === "10.0.2.2" ? "127.0.0.1" : host;
  log.info(`Downloading Burp CA from http://burp/cert via ${fetchHost}:${port}…`);
  const result = run("curl", [
    "--fail", "--silent", "--show-error",
    "--proxy", `http://${fetchHost}:${port}`,
    "http://burp/cert",
    "--output", certPath,
  ]);
  if (result.ok && existsSync(certPath) && statSync(certPath).size > 0) {
    // curl succeeding and writing a non-empty file only proves *something*
    // answered with a 2xx body — not that it was actually Burp's CA. A
    // captive portal page, a different service answering on that host:port,
    // or any other non-empty 200 response would satisfy this and previously
    // got logged as a successful download, only to fail opaquely one step
    // later. Validate the actual content before declaring success.
    if (readCertificate(certPath)) {
      log.good(`Burp CA downloaded to ${certPath}`);
      return certPath;
    }
    if (opensslAvailable()) {
      log.warn(
        `Burp responded on ${fetchHost}:${port} but the content doesn't look like a certificate — ` +
        `is Burp actually running and is that really its proxy listener?`,
      );
    }
    return null;
  }

  log.warn(`Could not download Burp CA automatically: ${result.stderr.trim() || "Burp listener did not respond"}`);
  return null;
}

/**
 * Never throws — a proxy/cert problem should degrade to "proxy interception
 * unavailable this run" (see README: "warns and continues rather than
 * aborting the whole setup"), not take down an otherwise-fully-successful
 * `bun run init`/`bun run.ts`. Returns null on any failure; the specific
 * reason (openssl missing vs. genuinely not a certificate) was already
 * logged by readCertificate()/opensslAvailable().
 */
function prepareAndroidCertificate(labRoot: string, certPath: string): { hash: string; derPath: string } | null {
  const info = readCertificate(certPath);
  if (!info) {
    if (opensslAvailable()) {
      log.warn(`Burp CA is not a readable X.509 certificate: ${certPath}`);
    }
    return null;
  }

  const derPath = join(labRoot, "cert", ".burp-ca.der");
  if (info.format === "DER") {
    if (certPath !== derPath) copyFileSync(certPath, derPath);
  } else {
    const convert = run("openssl", ["x509", "-in", certPath, "-outform", "DER", "-out", derPath]);
    if (!convert.ok) {
      log.warn(`Could not convert Burp CA to DER: ${convert.stderr.trim()}`);
      return null;
    }
  }
  return { hash: info.hash, derPath };
}

/**
 * Install the proxy's CA certificate into the device's system trust store
 * (tmpfs overlay — no writable-system, no reboot; see Adb.installSystemCert()
 * in src/adb.ts). Auto-downloads Burp's CA from http://burp/cert when
 * proxyTool is "burp"; otherwise expects a file under cert/ or --proxy-cert.
 *
 * Interactive: if no certificate is found or downloadable, prompts once for
 * the user to place it and retry. Called from both `bun run init`
 * (non-interactively skippable via --no-proxy) and `bun run.ts`.
 */
export async function ensureProxyCertificate(
  adb: ReturnType<typeof findAdb>,
  labRoot: string,
  platform: ReturnType<typeof detectPlatform>,
  burpHost: string,
  burpPort: number,
  requestedPath?: string,
  proxyTool: "burp" | "other" = "burp",
): Promise<void> {
  // downloadBurpCertificate() only works for Burp's magic http://burp/cert
  // endpoint — a different proxy tool (mitmproxy's http://mitm.it, etc.)
  // wouldn't answer there, so skip straight to the manual/--proxy-cert path
  // when the user has told us they're not using Burp.
  const autoDownload = () =>
    proxyTool === "burp" ? downloadBurpCertificate(labRoot, burpHost, burpPort) : null;

  let certPath = findProxyCertificate(labRoot, requestedPath) ?? autoDownload();
  if (!certPath) {
    log.warn(
      proxyTool === "burp"
        ? "Proxy CA was not found or could not be downloaded."
        : "Proxy CA was not found under cert/.",
    );
    if (proxyTool === "burp") {
      log.info("Export Burp's CA from http://burp/cert and save it as cert/burp-ca.cer.");
    } else {
      log.info("Export your proxy tool's CA certificate and save it under cert/ (any .cer/.crt/.der/.pem file).");
    }
    log.info("Alternatively pass --proxy-cert=<path> to use a certificate elsewhere.");
    const answer = prompt("After placing the certificate, type y to retry (or anything else to skip): ");
    if (answer?.trim().toLowerCase() !== "y") {
      log.warn("Proxy CA setup skipped. No certificate was provided.");
      return;
    }
    certPath = findProxyCertificate(labRoot, requestedPath) ?? autoDownload();
    if (!certPath) {
      log.warn("Proxy CA is still missing. Save it under cert/ and rerun (bun run init or bun run.ts).");
      return;
    }
  }

  const prepared = prepareAndroidCertificate(labRoot, certPath);
  if (!prepared) {
    log.warn(
      "Proxy CA setup skipped — root, Frida, and both emulators are unaffected; " +
      "fix the certificate (see the warning above) and rerun `bun run init` or `bun run.ts` to enable HTTPS interception.",
    );
    return;
  }
  const { hash, derPath } = prepared;
  log.info(`Using proxy CA: ${certPath}`);

  // Defense in depth: adb.push() throws on failure (a flaky post-boot binder
  // error, a device disconnect mid-push, etc.), and everything below this
  // point is on-device work that can fail in ways this function can't fully
  // predict. A cert-install hiccup here should degrade the same way a
  // missing/bad certificate above already does — not take down an
  // otherwise-fully-successful `bun run init` (root + Frida already done).
  try {
    log.info(`Installing into system trust store as ${hash}.0 (tmpfs overlay, no writable-system/reboot)…`);
    const ok = adb.installSystemCert(derPath, hash, (local, remote) => adb.push(local, remote, platform));

    // Also push the same DER cert to a fixed, well-known path — this is the
    // exact file the classic "frida-android-repinning.js"-style scripts
    // expect at /data/local/tmp/cert-der.crt (their own usage comment says to
    // `adb push burpca-cert-der.crt /data/local/tmp/cert-der.crt` by hand
    // before running them). Doing it here means any such script just works
    // without that manual step, using the exact same CA already installed
    // into the system trust store above.
    const REPIN_CERT_PATH = "/data/local/tmp/cert-der.crt";
    adb.push(derPath, REPIN_CERT_PATH, platform);
    adb.shell(`chmod 644 ${REPIN_CERT_PATH}`);
    log.good(`CA also pushed to ${REPIN_CERT_PATH} (for repinning-style Frida scripts).`);

    if (!ok) {
      log.warn(
        "Proxy CA was not installed into the system trust store.\n" +
          "The device must be rooted (it is, per the root check). As a fallback, the default\n" +
          "`bun run.ts` unpinning suite (scripts/unpinning/) can still use the CA pushed to\n" +
          "/data/local/tmp/cert-der.crt above without a system trust store entry.",
      );
      return;
    }
    log.good(`Proxy system CA installed: /system/etc/security/cacerts/${hash}.0`);
  } catch (error) {
    log.warn(
      `Proxy CA install failed: ${error instanceof Error ? error.message : String(error)}\n` +
      "  Root, Frida, and both emulators are unaffected — rerun `bun run init` or `bun run.ts` to retry.",
    );
  }
}

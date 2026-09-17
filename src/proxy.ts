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
import { run } from "./exec.ts";
import type { findAdb } from "./adb.ts";
import type { detectPlatform } from "./platform.ts";

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

function findProxyCertificate(labRoot: string, requested?: string): string | null {
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

  log.info(`Downloading Burp CA from http://burp/cert via ${host}:${port}…`);
  const result = run("curl", [
    "--fail", "--silent", "--show-error",
    "--proxy", `http://${host}:${port}`,
    "http://burp/cert",
    "--output", certPath,
  ]);
  if (result.ok && existsSync(certPath) && statSync(certPath).size > 0) {
    log.good(`Burp CA downloaded to ${certPath}`);
    return certPath;
  }

  log.warn(`Could not download Burp CA automatically: ${result.stderr.trim() || "Burp listener did not respond"}`);
  return null;
}

function prepareAndroidCertificate(labRoot: string, certPath: string): { hash: string; derPath: string } {
  const derPath = join(labRoot, "cert", ".burp-ca.der");
  for (const format of ["DER", "PEM"]) {
    const hashResult = run("openssl", ["x509", "-subject_hash_old", "-inform", format, "-in", certPath]);
    const hash = hashResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[0-9a-f]{8}$/i.test(line));
    if (!hash) continue;

    if (format === "DER") {
      if (certPath !== derPath) copyFileSync(certPath, derPath);
    } else {
      const convert = run("openssl", ["x509", "-in", certPath, "-outform", "DER", "-out", derPath]);
      if (!convert.ok) throw new Error(`Could not convert Burp CA to DER: ${convert.stderr.trim()}`);
    }
    return { hash: hash.toLowerCase(), derPath };
  }
  throw new Error(`Burp CA is not a readable X.509 certificate: ${certPath}`);
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

  const { hash, derPath } = prepareAndroidCertificate(labRoot, certPath);
  log.info(`Using proxy CA: ${certPath}`);
  log.info(`Installing into system trust store as ${hash}.0 (tmpfs overlay, no writable-system/reboot)…`);
  const ok = adb.installSystemCert(derPath, hash, (local, remote) => adb.push(local, remote, platform));
  if (!ok) {
    log.warn(
      "Proxy CA was not installed into the system trust store.\n" +
        "The device must be rooted (it is, per the root check). As a fallback you can\n" +
        "intercept HTTPS via the Frida SSL-unpinning script: --frida-script=scripts/ssl-unpinning.js",
    );
    return;
  }
  log.good(`Proxy system CA installed: /system/etc/security/cacerts/${hash}.0`);
}

#!/usr/bin/env bun
// ── Android Pentest Lab — run ─────────────────────────────────────────────────
//
// Quick-attach runner.  Assumes the lab is already bootstrapped.
//
//   ✓ Verify emulator is connected and booted
//   ✓ Verify root access
//   ✓ Verify / restart frida-server if needed
//   ✓ (Optional) Install APK
//   ✓ (Optional) Set up Burp proxy on device
//   ✓ Launch target app + attach Frida script
//
// Usage
// ─────
//   bun run.ts --package=com.example.app
//   bun run.ts --package=com.example.app --apk=./target.apk
//   bun run.ts --package=com.example.app --frida-script=./scripts/hook.js
//   bun run.ts --package=com.example.app --no-burp
//   bun run.ts --help
//
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { log, fail } from "./src/log.ts";
import { detectPlatform } from "./src/platform.ts";
import { loadConfig, printConfig } from "./src/config.ts";
import { findAdb } from "./src/adb.ts";
import {
  getHostFridaVersion,
  getFridaServer,
  deployFridaServer,
  verifyFridaConnection,
} from "./src/frida.ts";
import { run, runLive } from "./src/exec.ts";

// ── Run-specific CLI options ──────────────────────────────────────────────────

interface RunOptions {
  package?: string;
  apk?: string;
  mainActivity?: string;
  fridaScript?: string;
  sourceSerial: string;
  burpCert?: string;
  burp: boolean;
  spawnMode: boolean;     // --spawn: use frida --spawn instead of attaching
  verbose: boolean;
}

function parseRunArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    burp:       true,
    spawnMode:  false,
    verbose:    false,
    sourceSerial: process.env.LAB_SOURCE_SERIAL ?? "emulator-5556",
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      printRunHelp();
      process.exit(0);
    }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    switch (key) {
      case "package":        opts.package      = val; break;
      case "apk":            opts.apk          = val; break;
      case "main-activity":  opts.mainActivity = val; break;
      case "frida-script":   opts.fridaScript  = val; break;
      case "source-serial":  opts.sourceSerial = val ?? opts.sourceSerial; break;
      case "burp-cert":      opts.burpCert     = val; break;
      case "no-burp":        opts.burp         = false; break;
      case "spawn":          opts.spawnMode    = true; break;
      case "verbose":
      case "v":              opts.verbose       = true; break;
    }
  }
  return opts;
}

function printRunHelp(): void {
  console.log(`
\x1b[1mAndroid Pentest Lab — run.ts\x1b[0m

  Verify the lab is up and attach Frida to a target app.

\x1b[1mUsage\x1b[0m
  bun run.ts [options]

\x1b[1mRequired\x1b[0m
  --package=<pkg>           Target app package name (e.g. com.example.app)

\x1b[1mOptional\x1b[0m
  --apk=<path>              Install this APK before launching
  --main-activity=<name>    Activity to start (default: resolved from package)
  --frida-script=<path>     Frida JS script to load (default: scripts/hook.js if it exists)
  --source-serial=<id>      Play Store source emulator for automatic package recovery
  --burp-cert=<path>        Burp CA certificate (default: first cert in ./cert)
  --no-burp                 Skip Burp proxy configuration on device
  --spawn                   Use frida --spawn instead of attaching to running process
  --verbose, -v             Print extra debug output
  --help, -h                Show this help

\x1b[1mAll bootstrap options also apply\x1b[0m (passed through to config):
  --avd-name, --sdk-root, --frida-version, --burp-host, --burp-port, ...
  Run \`bun run bootstrap -- --help\` for the full list.

\x1b[1mExamples\x1b[0m
  # Attach to an already-running app
  bun run.ts --package=com.example.app

  # Install APK first, then attach with a hook script
  bun run.ts --package=com.example.app --apk=./target.apk --frida-script=./scripts/hook.js

  # Spawn the app fresh (frida controls the lifecycle)
  bun run.ts --package=com.example.app --spawn --frida-script=./scripts/hook.js

  # Skip Burp proxy setup
  bun run.ts --package=com.example.app --no-burp
`);
}

// ── Burp proxy helpers ────────────────────────────────────────────────────────

/**
 * Configure the emulator's global HTTP/HTTPS proxy to point at Burp.
 * Uses `adb shell settings put global http_proxy host:port`.
 * The emulator's default gateway 10.0.2.2 reaches the host machine's Burp listener.
 */
function setBurpProxy(adb: ReturnType<typeof findAdb>, host: string, port: number): void {
  log.step("Burp proxy");
  log.info(`Setting device proxy → ${host}:${port}`);
  adb.shell(`settings put global http_proxy ${host}:${port}`);
  const val = adb.shell("settings get global http_proxy");
  if (val.includes(`${host}:${port}`)) {
    log.good(`Proxy set: ${host}:${port}`);
  } else {
    log.warn(`Proxy setting may not have taken effect (got: ${val})`);
  }
  log.info("  Reminder: make sure Burp Suite is listening on all interfaces (0.0.0.0)");
  log.info(`  Burp > Proxy > Proxy Listeners > Binding address = All interfaces, port ${port}`);
}

// ── APK install ───────────────────────────────────────────────────────────────

function installApk(adb: ReturnType<typeof findAdb>, apkPath: string): void {
  log.step("APK install");
  if (!existsSync(apkPath)) {
    throw new Error(`APK not found: ${apkPath}`);
  }
  log.info(`Installing ${apkPath}…`);
  const serialArgs = adb.serial ? ["-s", adb.serial] : [];
  const r = run(adb.exePath, [...serialArgs, "install", "-r", "-t", apkPath]);
  if (!r.ok || r.stdout.includes("Failure")) {
    throw new Error(`APK install failed:\n${r.stderr.trim() || r.stdout.trim()}`);
  }
  log.good("APK installed.");
}

function packageInstalled(adb: ReturnType<typeof findAdb>, pkg: string): boolean {
  return adb.shell(`pm path ${pkg}`).split(/\r?\n/).some(line => line.trim().startsWith("package:"));
}

async function transferPackage(
  pkg: string,
  sourceSerial: string,
  targetSerial: string,
): Promise<void> {
  log.step("Automatic package recovery");
  log.info(`Package is not ready on ${targetSerial}; using source ${sourceSerial}.`);
  const code = await runLive("bun", [
    "src/transfer.ts",
    `--package=${pkg}`,
    `--source-serial=${sourceSerial}`,
    `--target-serial=${targetSerial}`,
  ]);
  if (code !== 0) {
    throw new Error(`Automatic package recovery failed with exit code ${code}.`);
  }
}

function findBurpCertificate(labRoot: string, requested?: string): string | null {
  if (requested) return existsSync(requested) ? requested : null;
  const certDir = join(labRoot, "cert");
  if (!existsSync(certDir)) return null;
  const name = readdirSync(certDir).find(file => /\.(cer|crt|der|pem)$/i.test(file));
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
    const hash = hashResult.stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^[0-9a-f]{8}$/i.test(line));
    if (!hash) continue;

    if (format === "DER") {
      const copy = run("powershell", ["-NoProfile", "-Command", `Copy-Item -LiteralPath '${certPath}' -Destination '${derPath}' -Force`]);
      if (!copy.ok) throw new Error(`Could not prepare Burp CA: ${copy.stderr.trim()}`);
    } else {
      const convert = run("openssl", ["x509", "-in", certPath, "-outform", "DER", "-out", derPath]);
      if (!convert.ok) throw new Error(`Could not convert Burp CA to DER: ${convert.stderr.trim()}`);
    }
    return { hash: hash.toLowerCase(), derPath };
  }
  throw new Error(`Burp CA is not a readable X.509 certificate: ${certPath}`);
}

async function ensureBurpCertificate(
  adb: ReturnType<typeof findAdb>,
  labRoot: string,
  platform: ReturnType<typeof detectPlatform>,
  burpHost: string,
  burpPort: number,
  requestedPath?: string,
): Promise<void> {
  const certPath = findBurpCertificate(labRoot, requestedPath) ??
    downloadBurpCertificate(labRoot, burpHost, burpPort);
  if (!certPath) {
    throw new Error("Burp CA download failed. Keep Burp listening and retry, or place a certificate in ./cert.");
  }

  const { hash, derPath } = prepareAndroidCertificate(labRoot, certPath);
  const marker = `/data/local/tmp/.android-pentest-lab-burp-cert-${hash}`;
  const destination = `/system/etc/security/cacerts/${hash}.0`;
  if (adb.rootShell(`test -f ${marker} && test -f ${destination} && echo YES || true`) === "YES") {
    log.good(`Burp system CA already installed: ${destination}`);
    return;
  }

  const remote = "/data/local/tmp/android-pentest-lab-burp-ca.der";
  log.info(`Using Burp CA: ${certPath}`);
  adb.push(derPath, remote, platform);
  log.info(`Installing rooted system CA: ${destination}`);
  const remount = adb.rootShell("mount -o rw,remount /system 2>/dev/null || mount -o rw,remount / 2>/dev/null || true");
  adb.rootShell(`mkdir -p /system/etc/security/cacerts && cp ${remote} ${destination} && chmod 644 ${destination} && chown 0:0 ${destination} && chcon u:object_r:system_file:s0 ${destination} 2>/dev/null || true`);
  adb.rootShell(`rm -f ${remote}`);
  const installed = adb.rootShell(`test -f ${destination} && stat -c '%a' ${destination} 2>/dev/null | grep -q 644 && echo YES || true`);
  if (installed !== "YES") {
    throw new Error(`Burp CA was not installed in the rooted system trust store. Remount output: ${remount}`);
  }
  adb.rootShell(`touch ${marker}`);
  log.good(`Burp system CA installed and verified: ${destination}`);
}

// ── App launch ────────────────────────────────────────────────────────────────

/**
 * Resolve the main activity for a package by querying the package manager.
 * Falls back to just the package name (some apps handle bare package starts).
 */
function resolveMainActivity(adb: ReturnType<typeof findAdb>, pkg: string): string | null {
  const out = adb.shell(`cmd package resolve-activity --brief ${pkg} 2>/dev/null`);
  // Output last non-empty line looks like: com.example.app/.MainActivity
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last && last.includes("/")) return last;
  return null;
}

function launchApp(adb: ReturnType<typeof findAdb>, pkg: string, activity?: string): void {
  log.step("Launch app");
  const target = activity ?? resolveMainActivity(adb, pkg);
  if (target) {
    log.info(`Starting: ${target}`);
    adb.shell(`am start -n ${target}`);
  } else {
    log.info(`Starting package: ${pkg}  (no activity resolved, using monkey)`);
    adb.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  }
  // Small delay to let the process appear
  Bun.sleepSync(1_500);
}

// ── frida-server health check ─────────────────────────────────────────────────

/**
 * Check whether frida-server is running on the device.
 * Returns the PID if found, null otherwise.
 */
function getFridaServerPid(adb: ReturnType<typeof findAdb>, version: string): string | null {
  const pid = adb.rootShell(`pidof frida-server-${version} 2>/dev/null || true`).trim();
  return pid || null;
}

// ── Frida attach ──────────────────────────────────────────────────────────────

/**
 * Attach (or spawn) Frida to the target package and optionally load a script.
 * This replaces the process with `frida` so the user sees its interactive REPL
 * (or the script output) in their terminal.
 */
async function attachFrida(
  pkg: string,
  serial: string,
  fridaScript: string | undefined,
  spawnMode: boolean,
  verbose: boolean,
): Promise<void> {
  log.step("Frida attach");

  const args: string[] = ["-D", serial];

  if (spawnMode) {
    args.push("--spawn", pkg);
    log.info(`Spawning ${pkg} under Frida…`);
  } else {
    args.push("-n", pkg);
    log.info(`Attaching to ${pkg}…`);
  }

  if (fridaScript) {
    if (!existsSync(fridaScript)) {
      throw new Error(`Frida script not found: ${fridaScript}`);
    }
    args.push("-l", fridaScript);
    log.info(`Loading script: ${fridaScript}`);
  }

  if (verbose) args.push("--runtime=v8");

  log.info(`Running: frida ${args.join(" ")}`);
  log.blank();

  // Hand off to Frida — inherit stdio so the user can interact with the REPL.
  const proc = Bun.spawn(["frida", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin:  "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`frida exited with code ${code}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Early --help (must come before loadConfig which exits on --help) ─────────
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printRunHelp();
    process.exit(0);
  }

  const labRoot  = import.meta.dir;
  const platform = detectPlatform();
  const cfg      = loadConfig(labRoot);
  const runOpts  = parseRunArgs(process.argv);

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log("\n\x1b[1m╔══════════════════════════════════════╗\x1b[0m");
  console.log(  "\x1b[1m║    Android Pentest Lab — Run         ║\x1b[0m");
  console.log(  "\x1b[1m╚══════════════════════════════════════╝\x1b[0m");
  printConfig(cfg);
  log.blank();

  // ── Require --package ──────────────────────────────────────────────────────
  if (!runOpts.package) {
    fail("--package=<app.package.name> is required.\n\n  Example: bun run.ts --package=com.example.app");
  }
  log.info(`Target: ${runOpts.package}`);

  // ── 1. ADB + device check ──────────────────────────────────────────────────
  log.step("Lab health check");
  const adb = findAdb(platform, cfg.sdkRoot, cfg.targetSerial);
  adb.startServer();

  const emulator = adb.getEmulator();
  if (!emulator) {
    fail(
      "No emulator visible to ADB.\n" +
      "  Start the lab first: bun run init\n" +
      "  Or start the emulator manually and rerun.",
    );
  }
  log.good(`Emulator connected: ${emulator}`);

  // Quick boot check (non-blocking poll — if it's already up, this returns fast)
  const booted = adb.shell("getprop sys.boot_completed") === "1";
  if (!booted) {
    log.info("Waiting for boot to complete…");
    adb.waitForBoot(cfg.emulatorBootTimeoutSec);
  } else {
    log.good("Android is fully booted.");
  }

  // ── 2. Root check ──────────────────────────────────────────────────────────
  log.step("Root");
  adb.verifyRoot();

  // ── 3. Frida version + server ──────────────────────────────────────────────
  log.step("Frida server");
  const fridaVersion = getHostFridaVersion();
  if (!fridaVersion) {
    fail("Frida host tools not found.\n  Run: bun run init");
  }
  log.good(`Host frida: ${fridaVersion}`);

  const abi        = adb.getAbi();
  const serverPath = await getFridaServer(fridaVersion, abi, cfg, platform);

  const existingPid = getFridaServerPid(adb, fridaVersion);
  if (existingPid) {
    // Verify it's actually reachable
    const check = run("frida-ps", ["-D", cfg.targetSerial]);
    if (check.ok) {
      log.good(`frida-server already running (PID=${existingPid}) and reachable.`);
    } else {
      log.warn("frida-server PID found but not reachable — redeploying…");
      await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform);
    }
  } else {
    log.info("frida-server not running — deploying…");
    await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform);
  }

  verifyFridaConnection(cfg.targetSerial);

  // ── 4. Burp proxy ──────────────────────────────────────────────────────────
  if (runOpts.burp) {
    setBurpProxy(adb, cfg.burpHost, cfg.burpPort);
    await ensureBurpCertificate(adb, labRoot, platform, cfg.burpHost, cfg.burpPort, runOpts.burpCert);
  } else {
    log.info("Burp proxy setup skipped (--no-burp).");
  }

  // ── 5. APK install ─────────────────────────────────────────────────────────
  let packageReady = packageInstalled(adb, runOpts.package);
  if (runOpts.apk) {
    if (!existsSync(runOpts.apk)) {
      log.warn(`APK not found: ${runOpts.apk}; trying the Play Store source instead.`);
    } else {
      try {
        installApk(adb, runOpts.apk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/MISSING_SPLIT|INSTALL_FAILED/i.test(message)) throw error;
        log.warn("Local APK is incomplete; trying the Play Store source instead.");
      }
      packageReady = packageInstalled(adb, runOpts.package);
    }
  }

  if (!packageReady) {
    await transferPackage(runOpts.package, runOpts.sourceSerial, cfg.targetSerial);
  }

  // ── 6. Launch app ──────────────────────────────────────────────────────────
  launchApp(adb, runOpts.package, runOpts.mainActivity);

  // ── 7. Locate Frida script ─────────────────────────────────────────────────
  let fridaScript = runOpts.fridaScript;
  if (!fridaScript) {
    const defaultScript = `${labRoot}/scripts/hook.js`;
    if (existsSync(defaultScript)) {
      fridaScript = defaultScript;
      log.info(`Using default hook script: ${defaultScript}`);
    }
  }

  // ── 8. Attach Frida ────────────────────────────────────────────────────────
  await attachFrida(runOpts.package, cfg.targetSerial, fridaScript, runOpts.spawnMode, runOpts.verbose);
}

main().catch(err => {
  log.blank();
  fail(err instanceof Error ? err.message : String(err));
});

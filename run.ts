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

import { existsSync } from "fs";
import { log, fail } from "./src/log.ts";
import { detectPlatform } from "./src/platform.ts";
import { DEFAULTS, loadConfig, printConfig } from "./src/config.ts";
import { findAdb } from "./src/adb.ts";
import { bringEmulatorWindowToFront } from "./src/avd.ts";
import { setDeviceProxy, ensureProxyCertificate, clearDeviceProxy, getDeviceProxy } from "./src/proxy.ts";
import { buildUnpinningScriptChain } from "./src/unpinning.ts";
import {
  activatePortablePython,
  getHostFridaVersion,
  getFridaServer,
  deployFridaServer,
  verifyFridaConnection,
} from "./src/frida.ts";
import { run, runLive } from "./src/exec.ts";
import { packageInstalled as sharedPackageInstalled } from "./src/apkpull.ts";

// ── Run-specific CLI options ──────────────────────────────────────────────────

interface RunOptions {
  package?: string;
  apk?: string;
  mainActivity?: string;
  fridaScript?: string;
  sourceSerial: string;
  burpCert?: string;
  burp: boolean;
  proxyTool: "burp" | "other";
  spawnMode: boolean; // --spawn: use frida --spawn instead of attaching
  verbose: boolean;
  clearProxy: boolean;
  noUnpinning: boolean;
}

function parseRunArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    burp: true,
    proxyTool: "burp",
    spawnMode: false,
    verbose: false,
    clearProxy: false,
    noUnpinning: false,
    sourceSerial: process.env.LAB_SOURCE_SERIAL ?? DEFAULTS.sourceSerial,
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
      case "package":
        opts.package = val;
        break;
      case "apk":
        opts.apk = val;
        break;
      case "main-activity":
        opts.mainActivity = val;
        break;
      case "frida-script":
        opts.fridaScript = val;
        break;
      case "source-serial":
        opts.sourceSerial = val ?? opts.sourceSerial;
        break;
      case "burp-cert":
      case "proxy-cert":
        opts.burpCert = val;
        break;
      case "no-burp":
      case "no-proxy":
        opts.burp = false;
        break;
      case "proxy-tool":
        opts.proxyTool = val === "other" ? "other" : "burp";
        break;
      case "clear-proxy":
        opts.clearProxy = true;
        break;
      case "no-unpinning":
        opts.noUnpinning = true;
        break;
      case "spawn":
        opts.spawnMode = true;
        break;
      case "verbose":
      case "v":
        opts.verbose = true;
        break;
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
  --frida-script=<path>     EXTRA Frida JS script, loaded after the unpinning
                            suite below (your own app-specific instrumentation).
                            Not a replacement for it unless --no-unpinning is
                            also passed.
  --no-unpinning            Skip the HTTPToolkit unpinning suite entirely.
                            Falls back to loading only --frida-script (or
                            scripts/hook.js, a minimal smoke test, if unset).
  --source-serial=<id>      Play Store source emulator for automatic package recovery
  --proxy-cert=<path>       Proxy CA certificate (default: first cert in ./cert)
                            (alias: --burp-cert)
  --proxy-tool=<burp|other> Whether to auto-fetch the CA from http://burp/cert [burp]
                            Set to "other" when using a non-Burp proxy tool —
                            skips the Burp-only auto-download and goes straight
                            to cert/ or --proxy-cert=<path>.
  --no-proxy                Skip proxy configuration on device entirely
                            (alias: --no-burp)
  --clear-proxy             Clear the device's proxy setting and exit
                            immediately (no package/APK/Frida steps run).
                            Uses --target-serial/--proxy-host/--proxy-port
                            from config, same as everything else — no need
                            to hand-run adb yourself.
  --spawn                   Use frida --spawn instead of attaching to running process
  --verbose, -v             Print extra debug output
  --help, -h                Show this help

\x1b[1mAll bootstrap options also apply\x1b[0m (passed through to config):
  --avd-name, --sdk-root, --frida-version, --proxy-host, --proxy-port, ...
  Run \`bun run init -- --help\` for the full list.

\x1b[1mCustom per-app pinning fixes\x1b[0m
  If the unpinning suite's own fallback layer logs "must be patched manually"
  for a specific app, drop a hand-written Frida hook at:
    scripts/custom/<package.name>.js
  It's auto-loaded after the unpinning suite whenever that package is run —
  no flag needed. See scripts/custom/README.md.

\x1b[1mExamples\x1b[0m
  # Attach to an already-running app (unpinning suite + Burp proxy, both default)
  bun run.ts --package=com.example.app

  # Install APK first, then attach with your own extra instrumentation script
  bun run.ts --package=com.example.app --apk=./target.apk --frida-script=./scripts/hook.js

  # Skip the unpinning suite entirely, use only your own script
  bun run.ts --package=com.example.app --no-unpinning --frida-script=./scripts/hook.js

  # Spawn the app fresh (frida controls the lifecycle)
  bun run.ts --package=com.example.app --spawn --frida-script=./scripts/hook.js

  # Use a different proxy tool (e.g. mitmproxy) instead of Burp
  bun run.ts --package=com.example.app --proxy-tool=other --proxy-host=10.0.2.2 --proxy-port=8080 --proxy-cert=./mitmproxy-ca.pem

  # Skip proxy setup entirely
  bun run.ts --package=com.example.app --no-proxy

  # Clear the device's proxy (send traffic direct again)
  bun run.ts --clear-proxy
`);
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
    throw new Error(
      `APK install failed:\n${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  log.good("APK installed.");
}

function packageInstalled(
  adb: ReturnType<typeof findAdb>,
  pkg: string,
): boolean {
  return sharedPackageInstalled((...args) => run(adb.exePath, [
    ...(adb.serial ? ["-s", adb.serial] : []),
    ...args,
  ]), pkg);
}

async function transferPackage(
  pkg: string,
  sourceSerial: string,
  targetSerial: string,
): Promise<void> {
  log.step("Automatic package recovery");
  log.info(
    `Package is not ready on ${targetSerial}; using source ${sourceSerial}.`,
  );
  const code = await runLive("bun", [
    "src/transfer.ts",
    `--package=${pkg}`,
    `--source-serial=${sourceSerial}`,
    `--target-serial=${targetSerial}`,
  ]);
  if (code !== 0) {
    throw new Error(
      `Automatic package recovery failed with exit code ${code}.`,
    );
  }
}

// ── App launch ────────────────────────────────────────────────────────────────

/**
 * Resolve the main activity for a package by querying the package manager.
 * Falls back to just the package name (some apps handle bare package starts).
 */
function resolveMainActivity(
  adb: ReturnType<typeof findAdb>,
  pkg: string,
): string | null {
  const out = adb.shell(
    `cmd package resolve-activity --brief ${pkg} 2>/dev/null`,
  );
  // Output last non-empty line looks like: com.example.app/.MainActivity
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (last && last.includes("/")) return last;
  return null;
}

function launchApp(
  adb: ReturnType<typeof findAdb>,
  pkg: string,
  activity?: string,
): void {
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
function getFridaServerPid(
  adb: ReturnType<typeof findAdb>,
  version: string,
): string | null {
  const pid = adb
    .rootShell(`pidof frida-server-${version} 2>/dev/null || true`)
    .trim();
  return pid || null;
}

function getAppPid(
  adb: ReturnType<typeof findAdb>,
  pkg: string,
): string | null {
  const pid = adb
    .shell(`pidof ${pkg} 2>/dev/null || true`)
    .trim()
    .split(/\s+/)[0];
  return /^\d+$/.test(pid) ? pid : null;
}

function waitForAppPid(
  adb: ReturnType<typeof findAdb>,
  pkg: string,
  timeoutMs = 10_000,
): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = getAppPid(adb, pkg);
    if (pid) return pid;
    Bun.sleepSync(500);
  }
  return null;
}

// ── Frida attach ──────────────────────────────────────────────────────────────

/**
 * Attach (or spawn) Frida to the target package, loading the HTTPToolkit
 * unpinning suite (scripts/unpinning/ — see src/unpinning.ts) by default,
 * plus an optional extra script layered on top. This replaces the process
 * with `frida` so the user sees its interactive REPL (or the script output)
 * in their terminal.
 *
 * @param extraScript  An additional `-l` script loaded AFTER the unpinning
 *   chain (or alone, if noUnpinning) — for your own app-specific
 *   instrumentation (--frida-script=<path>), separate from the automatic
 *   per-package override at scripts/custom/<pkg>.js (which src/unpinning.ts
 *   already appends to the chain itself when present).
 */
async function attachFrida(
  pkg: string,
  adb: ReturnType<typeof findAdb>,
  serial: string,
  labRoot: string,
  burpHost: string,
  burpPort: number,
  noUnpinning: boolean,
  extraScript: string | undefined,
  spawnMode: boolean,
  verbose: boolean,
): Promise<void> {
  log.step("Frida attach");

  // Frida's interactive REPL needs a minimum terminal size to draw its
  // prompt — too small and it just prints "Window too small..." and never
  // shows a usable console, even though the attach/script-load above it
  // succeeded fine. Catch that up front with a clear, actionable message
  // instead of letting the cryptic "Window too small..." be the only sign
  // something's wrong.
  const MIN_COLS = 80;
  const MIN_ROWS = 20;
  if (process.stdout.isTTY) {
    const cols = process.stdout.columns ?? 0;
    const rows = process.stdout.rows ?? 0;
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      throw new Error(
        `Terminal window is too small for Frida's interactive console ` +
          `(need at least ${MIN_COLS}x${MIN_ROWS}, got ${cols}x${rows}).\n` +
          `Enlarge your terminal window (or maximize it), then run this same command again.`,
      );
    }
  }

  const args: string[] = ["-D", serial];

  if (spawnMode) {
    args.push("-f", pkg);
    log.info(`Spawning ${pkg} under Frida…`);
  } else {
    const pid = waitForAppPid(adb, pkg);
    if (pid) {
      args.push("-p", pid);
      log.info(`Attaching to ${pkg} (PID=${pid})…`);
    } else {
      args.push("-n", pkg);
      log.info(`Attaching to ${pkg} by name…`);
    }
  }

  const scriptChain: string[] = [];
  if (!noUnpinning) {
    const chain = buildUnpinningScriptChain(labRoot, burpHost, burpPort, verbose, pkg);
    if (chain) {
      scriptChain.push(...chain);
      log.good(`Loading HTTPToolkit unpinning suite (${chain.length} scripts).`);
    } else {
      log.warn("Unpinning suite unavailable this run — see warning above. Continuing without it.");
    }
  }
  if (extraScript) {
    if (!existsSync(extraScript)) {
      throw new Error(`Frida script not found: ${extraScript}`);
    }
    scriptChain.push(extraScript);
    log.info(`Loading extra script: ${extraScript}`);
  }
  for (const script of scriptChain) args.push("-l", script);

  if (verbose) args.push("--runtime=v8");

  log.info(`Running: frida ${args.join(" ")}`);
  log.blank();

  // Hand off to Frida — inherit stdio so the user can interact with the REPL.
  const proc = Bun.spawn(["frida", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
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

  const labRoot = import.meta.dir;
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot);
  activatePortablePython(cfg);
  const runOpts = parseRunArgs(process.argv);

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log("\n\x1b[1m╔══════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║    Android Pentest Lab — Run         ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════╝\x1b[0m");
  printConfig(cfg);
  log.blank();

  // ── --clear-proxy: standalone action, exits immediately ───────────────────
  if (runOpts.clearProxy) {
    const adb = findAdb(platform, cfg.sdkRoot, cfg.targetSerial);
    adb.startServer();
    if (!adb.getEmulator()) {
      fail(`No emulator visible to ADB on serial ${cfg.targetSerial}.`);
    }
    const before = getDeviceProxy(adb);
    log.info(`Current proxy: ${before ?? "(none)"}`);
    clearDeviceProxy(adb);
    return;
  }

  // ── Require --package ──────────────────────────────────────────────────────
  if (!runOpts.package) {
    fail(
      "--package=<app.package.name> is required.\n\n  Example: bun run.ts --package=com.example.app",
    );
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

  // Raise + maximize the emulator window right before handing off to the
  // Frida REPL, so the app is visible and on top while you interact with it
  // to generate traffic (the Frida REPL runs in this terminal behind it).
  bringEmulatorWindowToFront(cfg.avdName);

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

  const abi = adb.getAbi();
  const serverPath = await getFridaServer(fridaVersion, abi, cfg, platform);

  const existingPid = getFridaServerPid(adb, fridaVersion);
  if (existingPid) {
    // Verify it's actually reachable
    const check = run("frida-ps", ["-D", cfg.targetSerial]);
    if (check.ok) {
      log.good(
        `frida-server already running (PID=${existingPid}) and reachable.`,
      );
    } else {
      log.warn("frida-server PID found but not reachable — redeploying…");
      await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform);
    }
  } else {
    log.info("frida-server not running — deploying…");
    await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform);
  }

  verifyFridaConnection(cfg.targetSerial);

  // ── 4. Proxy (Burp by default) ─────────────────────────────────────────────
  if (runOpts.burp) {
    setDeviceProxy(adb, cfg.burpHost, cfg.burpPort, runOpts.proxyTool);
    await ensureProxyCertificate(
      adb,
      labRoot,
      platform,
      cfg.burpHost,
      cfg.burpPort,
      runOpts.burpCert,
      runOpts.proxyTool,
    );
  } else {
    log.info("Proxy setup skipped (--no-proxy).");
  }

  // ── 5. APK install ─────────────────────────────────────────────────────────
  let packageReady = packageInstalled(adb, runOpts.package);
  if (runOpts.apk) {
    if (!existsSync(runOpts.apk)) {
      log.warn(
        `APK not found: ${runOpts.apk}; trying the Play Store source instead.`,
      );
    } else {
      try {
        installApk(adb, runOpts.apk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/MISSING_SPLIT|INSTALL_FAILED/i.test(message)) throw error;
        log.warn(
          "Local APK is incomplete; trying the Play Store source instead.",
        );
      }
      packageReady = packageInstalled(adb, runOpts.package);
    }
  }

  if (!packageReady) {
    await transferPackage(
      runOpts.package,
      runOpts.sourceSerial,
      cfg.targetSerial,
    );
  }

  // ── 6. Launch app ──────────────────────────────────────────────────────────
  if (!runOpts.spawnMode) {
    launchApp(adb, runOpts.package, runOpts.mainActivity);
  }

  // ── 7. Locate Frida script ─────────────────────────────────────────────────
  // The HTTPToolkit unpinning suite (scripts/unpinning/) is loaded by default
  // inside attachFrida() — see src/unpinning.ts. --frida-script here is an
  // ADDITIONAL script layered on top of it (your own app-specific
  // instrumentation), not a replacement, unless --no-unpinning is passed, in
  // which case it falls back to the old single-script behavior (defaulting
  // to scripts/hook.js, a minimal Java-runtime smoke test, if present).
  let extraScript = runOpts.fridaScript;
  if (!extraScript && runOpts.noUnpinning) {
    const defaultScript = `${labRoot}/scripts/hook.js`;
    if (existsSync(defaultScript)) {
      extraScript = defaultScript;
      log.info(`Using default hook script: ${defaultScript}`);
    }
  }

  // ── 8. Attach Frida ────────────────────────────────────────────────────────
  await attachFrida(
    runOpts.package,
    adb,
    cfg.targetSerial,
    labRoot,
    cfg.burpHost,
    cfg.burpPort,
    runOpts.noUnpinning,
    extraScript,
    runOpts.spawnMode,
    runOpts.verbose,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    log.blank();
    fail(err instanceof Error ? err.message : String(err));
  });
}

#!/usr/bin/env bun
// Transfer a Play Store installation from a source emulator to the rooted target.

import { existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { detectPlatform } from "./platform.ts";
import { DEFAULTS, loadConfig } from "./config.ts";
import { findAdb } from "./adb.ts";
import { log, fail } from "./log.ts";
import { run } from "./exec.ts";

interface TransferOptions {
  package?: string;
  sourceSerial: string;
  targetSerial: string;
  waitTimeoutSec: number;
  keepCache: boolean;
  noOpen: boolean;
}

function parseArgs(argv: string[]): TransferOptions {
  const options: TransferOptions = {
    sourceSerial: process.env.LAB_SOURCE_SERIAL ?? DEFAULTS.sourceSerial,
    targetSerial: process.env.LAB_TARGET_SERIAL ?? DEFAULTS.targetSerial,
    waitTimeoutSec: Number(process.env.LAB_TRANSFER_TIMEOUT ?? 600),
    keepCache: false,
    noOpen: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case "package": options.package = value; break;
      case "source-serial": options.sourceSerial = value ?? options.sourceSerial; break;
      case "target-serial": options.targetSerial = value ?? options.targetSerial; break;
      case "wait-timeout": options.waitTimeoutSec = Number(value); break;
      case "keep-cache": options.keepCache = true; break;
      case "no-open": options.noOpen = true; break;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`
Android Pentest Lab - transfer.ts

Transfer a complete Play Store installation, including split APKs, to the rooted target.

Usage
  bun run transfer -- --package=<pkg>

Options
  --package=<pkg>          Package to transfer (required)
  --source-serial=<id>     Play Store source [LAB_SOURCE_SERIAL]
  --target-serial=<id>     Rooted target [LAB_TARGET_SERIAL]
  --wait-timeout=<sec>     Source install timeout [600]
  --keep-cache             Keep APK cache in tools/cache/transfers
  --no-open                Do not open the Play Store page
  --help                   Show this help
`);
}

/**
 * Under real load (two emulators booting/running at once, which is exactly
 * this project's normal source+target setup) the system server can
 * transiently answer "Can't find service: <x>" or drop the binder
 * connection ("Broken pipe") for a moment right after boot or right after
 * an install/uninstall — observed directly, repeatedly, on this project's
 * own emulator pair. It always recovers within a few seconds. Retry a
 * couple of times on that specific class of error instead of hard-failing
 * the whole transfer on a hiccup that would have gone away on its own.
 */
function adb(adbPath: string, serial: string, ...args: string[]) {
  let r = run(adbPath, ["-s", serial, ...args]);
  for (let i = 0; !r.ok && /Can't find service|Broken pipe/i.test(r.stderr) && i < 3; i++) {
    Bun.sleepSync(2_000);
    r = run(adbPath, ["-s", serial, ...args]);
  }
  return r;
}

function assertDevice(adbPath: string, serial: string, label: string): void {
  const state = adb(adbPath, serial, "get-state");
  if (!state.ok || state.stdout.trim() !== "device") {
    throw new Error(`${label} '${serial}' is not online.\nRun: adb devices -l`);
  }
}

function packageApkPaths(adbPath: string, serial: string, pkg: string): string[] {
  const result = adb(adbPath, serial, "shell", "pm", "path", pkg);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/)
    .map(line => line.trim().replace(/^package:/, ""))
    .filter(path => path.endsWith(".apk"));
}

function packageInstalled(adbPath: string, serial: string, pkg: string): boolean {
  return packageApkPaths(adbPath, serial, pkg).length > 0;
}

function openPlayStore(adbPath: string, serial: string, pkg: string): void {
  log.info(`Opening Play Store page on ${serial}…`);
  const result = adb(adbPath, serial, "shell", "am", "start", "-a",
    "android.intent.action.VIEW", "-d", `market://details?id=${pkg}`);
  if (!result.ok) throw new Error(`Could not open Play Store page: ${result.stderr.trim()}`);
}

function waitForInstallation(adbPath: string, serial: string, pkg: string, timeoutSec: number): string[] {
  const deadline = Date.now() + timeoutSec * 1_000;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    const paths = packageApkPaths(adbPath, serial, pkg);
    if (paths.length > 0) return paths;
    if (Date.now() - lastNotice > 15_000) {
      log.info(`Waiting for ${pkg} to be installed on ${serial}…`);
      lastNotice = Date.now();
    }
    Bun.sleepSync(3_000);
  }
  throw new Error(`Package '${pkg}' was not installed on ${serial} within ${timeoutSec}s.`);
}

function pullApk(adbPath: string, serial: string, remotePath: string, localPath: string): void {
  const result = adb(adbPath, serial, "pull", remotePath, localPath);
  if (result.ok) return;
  const staged = `/sdcard/.android-pentest-lab-${basename(remotePath)}`;
  const stage = adb(adbPath, serial, "shell", "su", "-c",
    `cp '${remotePath.replace(/'/g, "'\\''")}' '${staged}'`);
  if (!stage.ok) throw new Error(`Could not pull ${remotePath}: ${result.stderr.trim() || stage.stderr.trim()}`);
  const stagedPull = adb(adbPath, serial, "pull", staged, localPath);
  adb(adbPath, serial, "shell", "rm", "-f", staged);
  if (!stagedPull.ok) throw new Error(`Could not pull staged APK ${remotePath}: ${stagedPull.stderr.trim()}`);
}

function installApks(adbPath: string, serial: string, paths: string[]): void {
  const result = run(adbPath, ["-s", serial, "install-multiple", "-r", "-t", ...paths]);
  if (!result.ok) throw new Error(`Target installation failed:\n${result.stderr.trim() || result.stdout.trim()}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  if (!options.package) fail("--package=<app.package.name> is required.");
  if (!Number.isFinite(options.waitTimeoutSec) || options.waitTimeoutSec <= 0) fail("--wait-timeout must be positive.");

  const labRoot = join(import.meta.dir, "..");
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot);
  const adbTool = findAdb(platform, cfg.sdkRoot);
  adbTool.startServer();
  const pkg = options.package;
  const cacheRoot = join(cfg.cacheDir, "transfers", pkg.replace(/[^A-Za-z0-9._-]/g, "_"));
  mkdirSync(cacheRoot, { recursive: true });

  console.log("\nAndroid Pentest Lab - APK transfer");
  console.log(`  Source: ${options.sourceSerial}`);
  console.log(`  Target: ${options.targetSerial}`);
  console.log(`  Package: ${pkg}\n`);
  assertDevice(adbTool.exePath, options.sourceSerial, "Source emulator");
  assertDevice(adbTool.exePath, options.targetSerial, "Target emulator");

  if (packageInstalled(adbTool.exePath, options.targetSerial, pkg)) {
    log.good(`Package ${pkg} is already installed on ${options.targetSerial}.`);
    return;
  }
  if (!packageInstalled(adbTool.exePath, options.sourceSerial, pkg) && !options.noOpen) {
    openPlayStore(adbTool.exePath, options.sourceSerial, pkg);
  }

  const remotePaths = waitForInstallation(adbTool.exePath, options.sourceSerial, pkg, options.waitTimeoutSec);
  log.good(`Found ${remotePaths.length} APK file(s) on source.`);
  const localPaths: string[] = [];
  for (const remotePath of remotePaths) {
    const localPath = join(cacheRoot, basename(remotePath));
    if (!existsSync(localPath)) {
      log.info(`Pulling ${basename(remotePath)}…`);
      pullApk(adbTool.exePath, options.sourceSerial, remotePath, localPath);
    } else log.info(`Using cached ${basename(remotePath)}.`);
    localPaths.push(localPath);
  }
  log.info(`Installing ${localPaths.length} APK file(s) on ${options.targetSerial}…`);
  installApks(adbTool.exePath, options.targetSerial, localPaths);
  log.good(`Installed ${pkg} on ${options.targetSerial}.`);
}

main().catch(error => {
  log.blank();
  fail(error instanceof Error ? error.message : String(error));
});

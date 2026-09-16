#!/usr/bin/env bun
// Initialize the rooted target lab and the Play Store source AVD.

import { existsSync } from "fs";
import { run, runLive } from "../src/exec.ts";
import { detectPlatform } from "../src/platform.ts";
import { listAvds } from "../src/avd.ts";
import { avdmanagerPath, emulatorPath, ensureSdk, sdkmanagerPath } from "../src/sdk.ts";
import { findAdb } from "../src/adb.ts";
import { loadConfig } from "../src/config.ts";
import { fail, log } from "../src/log.ts";

const LAB_ROOT = `${import.meta.dir}/..`;
const DEFAULT_SOURCE_AVD = "Pixel_10_Pro";
const DEFAULT_SOURCE_SERIAL = "emulator-5556";
const DEFAULT_SOURCE_IMAGE = "system-images;android-36.1;google_apis_playstore_ps16k;x86_64";
const DEFAULT_TIMEOUT_SEC = 300;

interface InitOptions {
  sourceAvd: string;
  sourceSerial: string;
  sourceImage: string;
  skipSource: boolean;
  timeoutSec: number;
}

function parseArgs(argv: string[]): InitOptions {
  const options: InitOptions = {
    sourceAvd: process.env.LAB_SOURCE_AVD ?? DEFAULT_SOURCE_AVD,
    sourceSerial: process.env.LAB_SOURCE_SERIAL ?? DEFAULT_SOURCE_SERIAL,
    sourceImage: process.env.LAB_SOURCE_IMAGE_PACKAGE ?? DEFAULT_SOURCE_IMAGE,
    skipSource: false,
    timeoutSec: Number(process.env.LAB_BOOT_TIMEOUT ?? DEFAULT_TIMEOUT_SEC),
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case "source-avd": options.sourceAvd = value ?? options.sourceAvd; break;
      case "source-serial": options.sourceSerial = value ?? options.sourceSerial; break;
      case "source-image-package": options.sourceImage = value ?? options.sourceImage; break;
      case "skip-source": options.skipSource = true; break;
      case "timeout": options.timeoutSec = Number(value); break;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`
Android Pentest Lab - initialize-lab.ts

Prepare the rooted target and start the optional Play Store source emulator.

Usage
  bun scripts/initialize-lab.ts
  bun scripts/initialize-lab.ts --install-sdk
  bun scripts/initialize-lab.ts --source-avd=Pixel_10_Pro
  bun scripts/initialize-lab.ts --skip-source

Source options
  --source-avd=<name>       Play Store AVD [${DEFAULT_SOURCE_AVD}]  LAB_SOURCE_AVD
  --source-serial=<id>      Play Store serial [${DEFAULT_SOURCE_SERIAL}]  LAB_SOURCE_SERIAL
  --source-image-package=<p> Android 36 Play Store image [${DEFAULT_SOURCE_IMAGE}]
  --skip-source             Prepare only the rooted target
  --timeout=<sec>           Source boot timeout [${DEFAULT_TIMEOUT_SEC}]
`);
}

function isOnline(adbPath: string, serial: string): boolean {
  const result = run(adbPath, ["-s", serial, "get-state"]);
  return result.ok && result.stdout.trim() === "device";
}

function startSourceEmulator(emuPath: string, avdName: string, platformType: string): void {
  const args = ["-avd", avdName, "-no-boot-anim", "-no-audio", "-gpu", "host"];
  log.info(`Starting source emulator: ${avdName}`);
  if (platformType === "windows") {
    const argStr = args.map(arg => `'${arg}'`).join(",");
    const command = `(Start-Process -FilePath '${emuPath}' -ArgumentList ${argStr} -WindowStyle Hidden -PassThru).Id`;
    const result = run("powershell", ["-NoProfile", "-Command", command]);
    if (!result.ok) throw new Error(`Could not start source emulator: ${result.stderr.trim()}`);
    return;
  }
  Bun.spawn([emuPath, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

async function ensureSourceAvd(
  sdkRoot: string,
  platform: ReturnType<typeof detectPlatform>,
  emuPath: string,
  avdName: string,
  imagePackage: string,
): Promise<void> {
  if (listAvds(emuPath).includes(avdName)) return;
  log.step("Play Store source AVD");
  log.info(`Source AVD '${avdName}' is missing; installing ${imagePackage}.`);
  const imageCode = await runLive(sdkmanagerPath(sdkRoot, platform), [
    `--sdk_root=${sdkRoot}`, "--install", imagePackage,
  ]);
  if (imageCode !== 0) {
    throw new Error(`Could not install source image '${imagePackage}'. Override --source-image-package.`);
  }
  const created = run(avdmanagerPath(sdkRoot, platform), [
    "create", "avd", "--name", avdName, "--package", imagePackage,
    "--device", "pixel_10_pro", "--force",
  ]);
  if (!created.ok && !created.stdout.includes("created")) {
    throw new Error(`Could not create source AVD:\n${created.stderr.trim() || created.stdout.trim()}`);
  }
  log.good(`Source AVD ready: ${avdName}`);
}

function waitForBoot(adbPath: string, serial: string, timeoutSec: number): void {
  log.info(`Waiting for ${serial} to boot (timeout ${timeoutSec}s)…`);
  const deadline = Date.now() + timeoutSec * 1_000;
  while (Date.now() < deadline) {
    if (isOnline(adbPath, serial)) {
      const boot = run(adbPath, ["-s", serial, "shell", "getprop", "sys.boot_completed"]);
      if (boot.ok && boot.stdout.trim() === "1") {
        process.stdout.write("\n");
        log.good(`${serial} is fully booted.`);
        return;
      }
    }
    process.stdout.write(".");
    Bun.sleepSync(3_000);
  }
  process.stdout.write("\n");
  throw new Error(`${serial} did not finish booting within ${timeoutSec}s.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) fail("--timeout must be positive.");

  const platform = detectPlatform();
  const cfg = loadConfig(LAB_ROOT);
  console.log("\nAndroid Pentest Lab - initialization");
  console.log(`  Rooted target: ${cfg.targetSerial} (${cfg.avdName})`);
  console.log(`  Play Store source: ${options.sourceSerial} (${options.sourceAvd})\n`);

  const sdkRoot = await ensureSdk(cfg, platform);
  cfg.sdkRoot = sdkRoot;
  const adb = findAdb(platform, sdkRoot, cfg.targetSerial);
  adb.startServer();

  const bootstrapArgs = process.argv.slice(2).filter(arg =>
    !arg.startsWith("--source-avd") && !arg.startsWith("--source-serial") &&
    !arg.startsWith("--source-image-package") && !arg.startsWith("--skip-source") &&
    !arg.startsWith("--timeout") && arg !== "--help" && arg !== "-h"
  );
  log.step("Rooted lab");
  const bootstrapCode = await runLive("bun", ["scripts/bootstrap-lab.ts", ...bootstrapArgs]);
  if (bootstrapCode !== 0) throw new Error(`bootstrap-lab.ts failed with exit code ${bootstrapCode}.`);
  if (options.skipSource) {
    log.info("--skip-source set; source emulator was not started.");
    return;
  }

  const emuPath = emulatorPath(sdkRoot, platform);
  if (!existsSync(emuPath)) throw new Error(`Android Emulator not found: ${emuPath}`);
  if (!listAvds(emuPath).includes(options.sourceAvd)) {
    if (!cfg.installSdk) throw new Error(`Source AVD '${options.sourceAvd}' was not found. Rerun with --install-sdk.`);
    await ensureSourceAvd(sdkRoot, platform, emuPath, options.sourceAvd, options.sourceImage);
  }

  log.step("Play Store source");
  if (isOnline(adb.exePath, options.sourceSerial)) {
    log.good(`Source emulator already connected: ${options.sourceSerial}`);
  } else {
    startSourceEmulator(emuPath, options.sourceAvd, platform.type);
    waitForBoot(adb.exePath, options.sourceSerial, options.timeoutSec);
  }
  log.blank();
  log.good("Both lab emulator roles are initialized.");
}

main().catch(error => {
  log.blank();
  fail(error instanceof Error ? error.message : String(error));
});

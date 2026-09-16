import { existsSync } from "fs";
import { run, runLive } from "./exec.ts";
import { detectPlatform } from "./platform.ts";
import { ensureAvd, listAvds, startEmulator } from "./avd.ts";
import { avdmanagerPath, emulatorPath, ensureSdk, sdkmanagerPath } from "./sdk.ts";
import { findAdb } from "./adb.ts";
import { DEFAULTS, loadConfig, printConfig } from "./config.ts";
import { fail, log } from "./log.ts";
import {
  ensureFridaHost,
  getFridaServer,
  deployFridaServer,
  verifyFridaConnection,
} from "./frida.ts";

const DEFAULT_SOURCE_AVD = DEFAULTS.sourceAvdName;
const DEFAULT_SOURCE_SERIAL = DEFAULTS.sourceSerial;
const DEFAULT_SOURCE_IMAGE = DEFAULTS.sourceImagePackage;
const DEFAULT_TIMEOUT_SEC = 300;

export interface InitializeOptions {
  sourceAvd: string;
  sourceSerial: string;
  sourceImage: string;
  skipSource: boolean;
  timeoutSec: number;
}

export function parseInitializeArgs(argv: string[]): InitializeOptions {
  const options: InitializeOptions = {
    sourceAvd: process.env.LAB_SOURCE_AVD ?? DEFAULT_SOURCE_AVD,
    sourceSerial: process.env.LAB_SOURCE_SERIAL ?? DEFAULT_SOURCE_SERIAL,
    sourceImage: process.env.LAB_SOURCE_IMAGE_PACKAGE ?? DEFAULT_SOURCE_IMAGE,
    skipSource: false,
    timeoutSec: Number(process.env.LAB_BOOT_TIMEOUT ?? DEFAULT_TIMEOUT_SEC),
  };
  for (const arg of argv) {
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

export function printInitializeHelp(): void {
  console.log(`
Android Pentest Lab - lab init

Usage
  bun run init
  bun run init -- --install-sdk
  bun run init -- --source-avd=Pixel_10_Pro
  bun run init -- --skip-source

Options
  --source-avd=<name>       Play Store AVD [LAB_SOURCE_AVD]
  --source-serial=<id>      Play Store serial [LAB_SOURCE_SERIAL]
  --source-image-package=<p> Play Store image [LAB_SOURCE_IMAGE_PACKAGE]
  --skip-source             Prepare only the rooted target
  --timeout=<sec>           Source boot timeout [${DEFAULT_TIMEOUT_SEC}]
`);
}

function isOnline(adbPath: string, serial: string): boolean {
  const result = run(adbPath, ["-s", serial, "get-state"]);
  return result.ok && result.stdout.trim() === "device";
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
  if (imageCode !== 0) throw new Error(`Could not install source image '${imagePackage}'. Override --source-image-package.`);
  const created = run(avdmanagerPath(sdkRoot, platform), [
    "create", "avd", "--name", avdName, "--package", imagePackage,
    "--device", "pixel_10_pro", "--force",
  ]);
  if (!created.ok && !created.stdout.includes("created")) {
    throw new Error(`Could not create source AVD:\n${created.stderr.trim() || created.stdout.trim()}`);
  }
  log.good(`Source AVD ready: ${avdName}`);
}

export async function bootstrapLab(labRoot: string, argv: string[] = process.argv.slice(2)): Promise<void> {
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot, argv);
  console.log("\nAndroid Pentest Lab - bootstrap");
  console.log(`  Platform: ${platform.type}${platform.isWsl ? " (WSL)" : ""}`);
  printConfig(cfg);
  log.blank();

  const sdkRoot = await ensureSdk(cfg, platform);
  cfg.sdkRoot = sdkRoot;
  await ensureAvd(cfg, platform);
  const adb = findAdb(platform, sdkRoot, cfg.targetSerial);
  adb.startServer();
  const emulatorAlreadyUp = !!adb.getEmulator();

  if (!emulatorAlreadyUp && !cfg.skipEmulator) {
    await startEmulator(cfg, platform);
    Bun.sleepSync(2_000);
  } else if (emulatorAlreadyUp) {
    log.good(`Target emulator already connected: ${cfg.targetSerial}`);
  } else {
    log.warn("--skip-emulator set and target emulator is not connected.");
  }
  adb.waitForBoot(cfg.emulatorBootTimeoutSec);

  log.step("Root");
  adb.verifyRoot();
  const fridaVersion = await ensureFridaHost(cfg);
  log.step("frida-server");
  const abi = adb.getAbi();
  log.info(`Device ABI: ${abi}`);
  const serverPath = await getFridaServer(fridaVersion, abi, cfg, platform);
  await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform, cfg.forceFrida);
  log.step("Final check");
  verifyFridaConnection(cfg.targetSerial);
  log.good(`LAB READY: ${cfg.avdName} / Android ${adb.getAndroidVersion()} / Frida ${fridaVersion}`);
}

export async function initializeLab(labRoot: string, argv: string[]): Promise<void> {
  const options = parseInitializeArgs(argv);
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) fail("--timeout must be positive.");
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot, argv);
  console.log("\nAndroid Pentest Lab - initialization");
  console.log(`  Rooted target: ${cfg.targetSerial} (${cfg.avdName})`);
  console.log(`  Play Store source: ${options.sourceSerial} (${options.sourceAvd})\n`);

  const sdkRoot = await ensureSdk(cfg, platform);
  cfg.sdkRoot = sdkRoot;
  const adb = findAdb(platform, sdkRoot, cfg.targetSerial);
  adb.startServer();
  const bootstrapArgs = argv.filter(arg =>
    !arg.startsWith("--source-avd") && !arg.startsWith("--source-serial") &&
    !arg.startsWith("--source-image-package") && !arg.startsWith("--skip-source") &&
    !arg.startsWith("--timeout") && arg !== "--help" && arg !== "-h"
  );
  await bootstrapLab(labRoot, bootstrapArgs);
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
  log.good("Both lab emulator roles are initialized.");
}

export async function runE2E(labRoot: string, argv: string[]): Promise<void> {
  const runOnlyFlags = new Set(["--package", "--apk", "--main-activity", "--frida-script", "--burp-cert", "--no-burp", "--spawn", "--verbose", "-v"]);
  const initArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = arg.split("=", 1)[0];
    if (runOnlyFlags.has(key)) {
      if (!arg.includes("=") && ["--package", "--apk", "--main-activity", "--frida-script", "--burp-cert"].includes(arg)) index++;
      continue;
    }
    initArgs.push(arg);
  }
  if (!initArgs.includes("--install-sdk")) initArgs.push("--install-sdk");
  log.step("End-to-end initialization");
  await initializeLab(labRoot, initArgs);
  log.step("End-to-end application run");
  const code = await runLive("bun", ["run.ts", ...argv], { cwd: labRoot });
  if (code !== 0) throw new Error(`run.ts failed with exit code ${code}.`);
}

export function printLabHelp(): void {
  console.log(`
Android Pentest Lab - lab command

Usage
  bun run init -- [options]       Initialize target and source emulators
  bun run bootstrap -- [options]  Bootstrap only the rooted target
  bun run e2e -- --package=<pkg>  Initialize, install, Burp, launch, and Frida

The transfer workflow is available as: bun run transfer -- --package=<pkg>
`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    printLabHelp();
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    if (command === "init") printInitializeHelp();
    else printLabHelp();
    return;
  }
  const labRoot = `${import.meta.dir}/..`;
  switch (command) {
    case "bootstrap":
      await bootstrapLab(labRoot, args);
      return;
    case "init":
      await initializeLab(labRoot, args);
      return;
    case "e2e":
      await runE2E(labRoot, args);
      return;
    default:
      throw new Error(`Unknown lab command '${command}'. Use: bun run help`);
  }
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});

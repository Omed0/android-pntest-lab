import { existsSync } from "fs";
import { run, runLive } from "./exec.ts";
import { detectPlatform } from "./platform.ts";
import { applyGpuConfig, bringEmulatorWindowToFront, ensureAvd, killEmulator, launchWindowsEmulator, listAvds, lockEmulatorWindow, resolveDeviceProfile, startEmulator } from "./avd.ts";
import { avdmanagerPath, emulatorPath, ensureSdk, sdkmanagerPath } from "./sdk.ts";
import { Adb, findAdb } from "./adb.ts";
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
// A brand-new Play Store source AVD's very first boot has no boot snapshot
// yet and has to cold-boot Google Play Services — verified directly to take
// well over 300s (previous default) on a fresh AVD, timing out even though
// the emulator was booting correctly and finished a few minutes later.
// Subsequent boots reuse the snapshot and are fast; --timeout=<sec> still
// overrides this per-run if a given machine needs more.
const DEFAULT_TIMEOUT_SEC = 600;

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

function startSourceEmulator(emuPath: string, avdName: string, platformType: string, gpuMode: string, showWindow: boolean, cacheDir: string): void {
  // -no-snapshot + (no) -writable-system: see the matching comments in src/avd.ts startEmulator().
  const args = ["-avd", avdName, "-no-boot-anim", "-no-audio", "-no-snapshot", "-gpu", gpuMode];
  log.info(`Starting source emulator: ${avdName}`);
  if (platformType === "windows") {
    // See launchWindowsEmulator() in src/avd.ts for why this redirects
    // stdio instead of just setting -WindowStyle: it's what stops Windows
    // from also popping up a bare console/terminal window alongside the
    // emulator's own display window.
    const pid = launchWindowsEmulator(emuPath, args, avdName, cacheDir, showWindow);
    if (!pid) throw new Error("Could not start source emulator (no PID returned).");
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
  deviceProfile: string,
): Promise<void> {
  if (listAvds(emuPath).includes(avdName)) return;
  log.step("Play Store source AVD");
  log.info(`Source AVD '${avdName}' is missing; installing ${imagePackage}.`);
  // See src/sdk.ts installHeadlessSdk() for why --sdk_root=<path> must
  // never be passed on sdkmanager.bat's argv when <path> contains a space —
  // ANDROID_SDK_ROOT/ANDROID_HOME env vars carry it instead.
  const imageCode = await runLive(sdkmanagerPath(sdkRoot, platform), [
    "--install", imagePackage,
  ], { env: { ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: sdkRoot } });
  if (imageCode !== 0) throw new Error(`Could not install source image '${imagePackage}'. Override --source-image-package.`);
  const avdmgr = avdmanagerPath(sdkRoot, platform);
  // Was previously hardcoded to "pixel_10_pro", which doesn't exist on the
  // device-definition list shipped with the auto-downloaded "command-line
  // tools only" package (only up to pixel_7_pro/pixel_tablet at the time of
  // writing) — every from-scratch install hit "Error: No device found
  // matching --device pixel_10_pro." resolveDeviceProfile() falls back to
  // the newest available Pixel profile instead of hard-failing.
  const deviceId = resolveDeviceProfile(avdmgr, deviceProfile);
  const created = run(avdmgr, [
    "create", "avd", "--name", avdName, "--package", imagePackage,
    "--device", deviceId, "--force",
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

  let weStartedIt = false;
  if (!emulatorAlreadyUp && !cfg.skipEmulator) {
    await startEmulator(cfg, platform);
    Bun.sleepSync(2_000);
    weStartedIt = true;
  } else if (emulatorAlreadyUp) {
    log.good(`Target emulator already connected: ${cfg.targetSerial}`);
  } else {
    log.warn("--skip-emulator set and target emulator is not connected.");
  }

  try {
    adb.waitForBoot(cfg.emulatorBootTimeoutSec);
  } catch (error) {
    // A boot timeout right after we launched the emulator ourselves is
    // consistent with a GPU-init failure (black screen) rather than a slow
    // cold boot — this is the same class of failure the emulator's own
    // "-gpu auto" is supposed to sidestep, but some VM hosts still need an
    // explicit push to software rendering. Retry exactly once before
    // surfacing the original error, so a genuinely broken setup still fails
    // fast instead of retrying forever.
    if (!weStartedIt || cfg.gpuMode === "swiftshader_indirect") throw error;
    log.warn("Emulator boot timed out — retrying once with software rendering (-gpu swiftshader_indirect), common on VMs like VMware…");
    killEmulator(adb.exePath, cfg.targetSerial);
    Bun.sleepSync(3_000);
    await startEmulator(cfg, platform, "swiftshader_indirect");
    Bun.sleepSync(2_000);
    adb.waitForBoot(cfg.emulatorBootTimeoutSec);
  }

  // Sanity-check the display renderer (warn only). The real black-screen
  // cause was hw.gpu.enabled=no in the AVD config, now fixed in
  // applyHardwareConfig() — so a healthy render is expected here. This stays
  // a non-fatal warning rather than auto-switching to swiftshader: with GPU
  // properly enabled, switching to software rendering would make a working
  // display worse, and rendering never blocks Frida/ADB/proxy work anyway.
  if (weStartedIt && !adb.rendererHealthy()) {
    log.warn("Emulator display renderer check did not pass (screencap failed). If the screen is black/white/grey, try --gpu-mode=swiftshader_indirect, or confirm hw.gpu.enabled=yes in the AVD's config.ini. Frida/ADB/proxy functionality is unaffected.");
  }

  log.step("Root");
  adb.verifyRoot();
  const fridaVersion = await ensureFridaHost(cfg, platform);
  log.step("frida-server");
  const abi = adb.getAbi();
  log.info(`Device ABI: ${abi}`);
  const serverPath = await getFridaServer(fridaVersion, abi, cfg, platform);
  await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform, cfg.forceFrida);
  log.step("Final check");
  verifyFridaConnection(cfg.targetSerial);
  log.good(`LAB READY: ${cfg.avdName} / Android ${adb.getAndroidVersion()} / Frida ${fridaVersion}`);
  // Raise + maximize the emulator window as the very last action, so none of
  // the root/frida/adb steps above (which steal focus) leave it buried.
  if (weStartedIt && cfg.showWindow) bringEmulatorWindowToFront(cfg.avdName);
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
    await ensureSourceAvd(sdkRoot, platform, emuPath, options.sourceAvd, options.sourceImage, cfg.sourceDeviceProfile);
  }
  // Enable GPU on the source AVD too — unconditionally, so a source AVD that
  // already existed from a prior run (ensureSourceAvd early-returns for it)
  // still gets GPU turned on. Without this the Pixel 10 Pro source kept
  // hw.gpu.enabled=no and hung in software rendering until the boot timeout.
  applyGpuConfig(options.sourceAvd);
  lockEmulatorWindow(cfg, options.sourceAvd, platform);
  log.step("Play Store source");
  if (isOnline(adb.exePath, options.sourceSerial)) {
    log.good(`Source emulator already connected: ${options.sourceSerial}`);
  } else {
    startSourceEmulator(emuPath, options.sourceAvd, platform.type, cfg.gpuMode, cfg.showWindow, cfg.cacheDir);
    try {
      waitForBoot(adb.exePath, options.sourceSerial, options.timeoutSec);
    } catch (error) {
      // Same GPU-init-failure retry as the target emulator in bootstrapLab().
      if (cfg.gpuMode === "swiftshader_indirect") throw error;
      log.warn("Source emulator boot timed out — retrying once with software rendering (-gpu swiftshader_indirect), common on VMs like VMware…");
      killEmulator(adb.exePath, options.sourceSerial);
      Bun.sleepSync(3_000);
      startSourceEmulator(emuPath, options.sourceAvd, platform.type, "swiftshader_indirect", cfg.showWindow, cfg.cacheDir);
      waitForBoot(adb.exePath, options.sourceSerial, options.timeoutSec);
    }

    // Display renderer sanity check (warn only) — matters here since Play
    // Store sign-in and the initial "Install" tap need a visible screen. The
    // real black-screen cause (hw.gpu.enabled=no) is fixed in
    // applyHardwareConfig(); don't auto-switch to swiftshader, which would
    // only degrade a working GPU display.
    const sourceAdb = new Adb(adb.exePath, options.sourceSerial);
    if (!sourceAdb.rendererHealthy()) {
      log.warn("Source emulator display renderer check did not pass. If its screen is black/white/grey, confirm hw.gpu.enabled=yes in the source AVD's config.ini, or try --gpu-mode=swiftshader_indirect.");
    }
    if (cfg.showWindow) bringEmulatorWindowToFront(options.sourceAvd);
  }
  log.good("Both lab emulator roles are initialized.");
}

export async function runE2E(labRoot: string, argv: string[]): Promise<void> {
  const runOnlyFlags = new Set([
    "--package", "--apk", "--main-activity", "--frida-script",
    "--burp-cert", "--proxy-cert", "--no-burp", "--no-proxy", "--proxy-tool",
    "--spawn", "--verbose", "-v",
  ]);
  const runOnlyFlagsWithValue = ["--package", "--apk", "--main-activity", "--frida-script", "--burp-cert", "--proxy-cert", "--proxy-tool"];
  const initArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = arg.split("=", 1)[0];
    if (runOnlyFlags.has(key)) {
      if (!arg.includes("=") && runOnlyFlagsWithValue.includes(arg)) index++;
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
  bun run e2e -- --package=<pkg>  Initialize, install, proxy (Burp by default), launch, and Frida

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

import { existsSync } from "fs";
import { rmSync } from "fs";
import { run, runLive } from "./exec.ts";
import { detectPlatform } from "./platform.ts";
import { applyGpuConfig, bringEmulatorWindowToFront, ensureAvd, killEmulator, launchWindowsEmulator, listAvds, lockEmulatorWindow, resolveDeviceProfile, startEmulator } from "./avd.ts";
import { avdmanagerPath, emulatorPath, ensureSdk, sdkmanagerPath } from "./sdk.ts";
import { Adb, findAdb } from "./adb.ts";
import { DEFAULTS, loadConfig, printConfig } from "./config.ts";
import { ensureMagiskRoot } from "./magisk.ts";
import { setDeviceProxy, ensureProxyCertificate, clearDeviceProxy, getDeviceProxy } from "./proxy.ts";
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
  bun run init -- --magisk-root

Options
  --source-avd=<name>       Play Store AVD [LAB_SOURCE_AVD]
  --source-serial=<id>      Play Store serial [LAB_SOURCE_SERIAL]
  --source-image-package=<p> Play Store image [LAB_SOURCE_IMAGE_PACKAGE]
  --skip-source             Prepare only the rooted target
  --timeout=<sec>           Source boot timeout [${DEFAULT_TIMEOUT_SEC}]
  --magisk-root             Patch the target with real Magisk (see --help in config)
`);
}

/**
 * Start the source (Play Store) emulator.
 *
 * @param gpuModeOverride  When omitted, NO `-gpu` flag is passed at all —
 *   confirmed directly that launching this AVD exactly like Android
 *   Studio's own Device Manager does (no explicit `-gpu` CLI override,
 *   letting hw.gpu.mode=auto from config.ini be the only GPU setting in
 *   effect) renders correctly, while this project's own earlier custom
 *   `-gpu auto`/`-gpu swiftshader_indirect` CLI override on the same AVD
 *   produced real instability. Only the boot-timeout retry path passes an
 *   explicit override (cfg.sourceGpuMode).
 */
function startSourceEmulator(emuPath: string, avdName: string, platformType: string, gpuModeOverride: string | undefined, showWindow: boolean, cacheDir: string): void {
  // Deliberately just "-avd <name>" and nothing else — matching Android
  // Studio's own Device Manager launch exactly, per the same reasoning as
  // omitting -gpu above. Earlier revisions also forced -no-boot-anim
  // -no-audio -no-snapshot here (copied from the target's flags in
  // src/avd.ts startEmulator()), but Device Manager passes none of those
  // either: it lets the AVD's own fastboot.* quickboot settings in
  // config.ini apply instead of always forcing a cold boot. That's the
  // confirmed-working launch shape for this AVD; the target keeps its own
  // flags unchanged (it has no such quickboot-vs-coldboot problem).
  const args = ["-avd", avdName];
  if (gpuModeOverride) args.push("-gpu", gpuModeOverride);
  log.info(`Starting source emulator: ${avdName}${gpuModeOverride ? ` (-gpu ${gpuModeOverride})` : " (default GPU mode, like Device Manager)"}`);
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

/** Returns true if the AVD was actually created by this call (false if it already existed). */
async function ensureSourceAvd(
  sdkRoot: string,
  platform: ReturnType<typeof detectPlatform>,
  emuPath: string,
  avdName: string,
  imagePackage: string,
  deviceProfile: string,
): Promise<boolean> {
  if (listAvds(emuPath).includes(avdName)) return false;
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
  return true;
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
  // applyGpuConfig() — so a healthy render is expected here. This stays a
  // non-fatal warning rather than auto-switching to swiftshader: with GPU
  // properly enabled, switching to software rendering would make a working
  // display worse, and rendering never blocks Frida/ADB/proxy work anyway.
  if (weStartedIt && !adb.rendererHealthy()) {
    log.warn("Emulator display renderer check did not pass (screencap failed). If the screen is black/white/grey, try --gpu-mode=swiftshader_indirect, or confirm hw.gpu.enabled=yes in the AVD's config.ini. Frida/ADB/proxy functionality is unaffected.");
  }

  log.step("Root");
  let alreadyRooted = true;
  try {
    adb.verifyRoot();
    log.good("Root verified on target (adb root).");
  } catch (error) {
    // A Play Store image has neither `adb root` (blocked by Google) nor an
    // `su` binary until Magisk is actually patched onto it — verifyRoot()
    // throwing here is EXPECTED on a fresh --system-image-tag=google_apis_playstore
    // target with --magisk-root, not a real failure yet. Only bail out
    // immediately if Magisk root wasn't even requested — that's the
    // original "genuinely unrooted, nothing more to try" case.
    if (!cfg.magiskRoot) throw error;
    alreadyRooted = false;
    log.warn("adb-root unavailable (expected on a fresh Play Store image before Magisk is patched) — attempting Magisk root now…");
  }
  await ensureMagiskRoot(cfg, platform, adb);
  if (!alreadyRooted) {
    // Only re-check if the first attempt above actually failed — this
    // surfaces the real (correctly still-failing) error if the Magisk
    // patch didn't grant root, without a redundant re-verification log
    // when root was already confirmed working the first time.
    adb.verifyRoot();
  }
  const fridaVersion = await ensureFridaHost(cfg, platform);
  log.step("frida-server");
  const abi = adb.getAbi();
  log.info(`Device ABI: ${abi}`);
  const serverPath = await getFridaServer(fridaVersion, abi, cfg, platform);
  await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform, cfg.forceFrida);
  log.step("Final check");
  verifyFridaConnection(cfg.targetSerial);
  log.good("Frida verified and working on target.");

  // Proxy + CA cert: done here (once, device-wide) so the lab is
  // proxy-ready the moment `bun run init` finishes, instead of only being
  // set up on the first `bun run.ts`. `bun run.ts` re-applies the same
  // idempotent steps anyway (e.g. after a device restart, or to switch to a
  // different proxy tool for one run), so doing it here too is never
  // wasted work. --no-proxy skips this entirely.
  if (cfg.proxyEnabled) {
    setDeviceProxy(adb, cfg.burpHost, cfg.burpPort, cfg.proxyTool);
    await ensureProxyCertificate(adb, labRoot, platform, cfg.burpHost, cfg.burpPort, undefined, cfg.proxyTool);
  } else {
    log.info("Proxy setup skipped (--no-proxy).");
  }

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

  // --clear-proxy: standalone action against the already-running target,
  // using the same --target-serial/--sdk-root resolution as everything
  // else — no need to hand-build adb commands. Exits immediately, same as
  // `bun run run -- --clear-proxy`.
  if (argv.includes("--clear-proxy")) {
    const sdkRoot = await ensureSdk(cfg, platform);
    const adb = findAdb(platform, sdkRoot, cfg.targetSerial);
    adb.startServer();
    if (!adb.getEmulator()) fail(`No emulator visible to ADB on serial ${cfg.targetSerial}.`);
    const before = getDeviceProxy(adb);
    log.info(`Current proxy: ${before ?? "(none)"}`);
    clearDeviceProxy(adb);
    return;
  }

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
  let justCreated = false;
  if (!listAvds(emuPath).includes(options.sourceAvd)) {
    if (!cfg.installSdk) throw new Error(`Source AVD '${options.sourceAvd}' was not found. Rerun with --install-sdk.`);
    justCreated = await ensureSourceAvd(sdkRoot, platform, emuPath, options.sourceAvd, options.sourceImage, cfg.sourceDeviceProfile);
  }
  // Enable GPU on the source AVD too — unconditionally, so a source AVD that
  // already existed from a prior run (ensureSourceAvd early-returns for it)
  // still gets GPU turned on. Without this the Pixel 10 Pro source kept
  // hw.gpu.enabled=no and hung in software rendering until the boot timeout.
  // This is the ONLY GPU/window handling applied to the source: it mirrors
  // exactly what avdmanager/Android Studio itself writes into config.ini for
  // a normal AVD. No `-gpu` CLI override and no lockEmulatorWindow() call
  // are applied to the source below — confirmed directly that launching
  // this AVD with neither (i.e. identical to opening it from Android
  // Studio's own Device Manager) is what actually renders correctly; this
  // project's own earlier custom `-gpu`/window-lock handling on this AVD
  // produced the instability, not the absence of it.
  applyGpuConfig(options.sourceAvd);
  log.step("Play Store source");
  const sourceAdb = new Adb(adb.exePath, options.sourceSerial);
  if (sourceAdb.getEmulator()) {
    log.good(`Source emulator already connected: ${options.sourceSerial}`);
  } else {
    // A brand-new source AVD has no boot snapshot yet and must cold-boot the
    // full guest graphics stack — confirmed directly (from-scratch test,
    // 2026-09-17) that this specific combination (this preview android-37.0
    // Play Store image + host-GPU/gfxstream on an AMD Radeon 780M iGPU)
    // crash-loops SurfaceFlinger on that cold init, showing as an endless
    // restarting boot animation. An AVD that already existed before this run
    // (justCreated=false) can load its saved snapshot instead and never hits
    // that cold-init path, which is the case that was confirmed to render
    // correctly with no `-gpu` override at all (matching Device Manager).
    // So: force software rendering ONLY for that one first-ever cold boot;
    // every subsequent boot of this same AVD goes through the flagless path.
    const firstBootOverride = justCreated ? cfg.sourceGpuMode : undefined;
    startSourceEmulator(emuPath, options.sourceAvd, platform.type, firstBootOverride, cfg.showWindow, cfg.cacheDir);
    try {
      sourceAdb.waitForBoot(options.timeoutSec);
    } catch (error) {
      // Same GPU-init-failure retry idea as the target emulator in
      // bootstrapLab() — covers a non-fresh AVD whose flagless boot still
      // times out for some other reason.
      if (firstBootOverride) throw error;
      log.warn(`Source emulator boot timed out — retrying once with explicit -gpu ${cfg.sourceGpuMode}…`);
      killEmulator(adb.exePath, options.sourceSerial);
      Bun.sleepSync(3_000);
      startSourceEmulator(emuPath, options.sourceAvd, platform.type, cfg.sourceGpuMode, cfg.showWindow, cfg.cacheDir);
      sourceAdb.waitForBoot(options.timeoutSec);
    }

    // No renderer-health warning here (unlike the target): `screencap` was
    // confirmed to throw an assertion failure on this system-image class
    // regardless of whether the actual display is healthy or genuinely
    // blank, so the check has zero diagnostic value for source and only
    // produced a confusing "still broken" message on every successful run.
    // Verify the source's display visually instead.
    // maximize=true here (unlike the target): the source has no
    // window.scale/lock applied at all, so a real OS maximize is what sizes
    // its window — see bringEmulatorWindowToFront()'s doc comment.
    if (cfg.showWindow) bringEmulatorWindowToFront(options.sourceAvd, true);
  }
  log.good("Both lab emulator roles are initialized.");
}

function removeDirWithRetry(path: string, label: string): void {
  if (!existsSync(path)) return;
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      log.good(`Removed ${label}: ${path}`);
      return;
    } catch (error: any) {
      const code = error?.code;
      if ((code === "EBUSY" || code === "EPERM") && i < attempts - 1) {
        log.info(`${label} is busy, retrying (${i + 1}/${attempts})…`);
        Bun.sleepSync(1_500 * (i + 1));
        continue;
      }
      log.warn(`Could not fully remove ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

export function printCleanHelp(): void {
  console.log(`
Android Pentest Lab - clean

Deletes this lab's AVDs and everything downloaded under tools/ (SDK, cache,
Frida binaries) so the next "bun run init" rebuilds from scratch. Does not
touch your own APKs or files under cert/.

Usage
  bun run clean
`);
}

export async function cleanLab(labRoot: string, argv: string[]): Promise<void> {
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot, argv);
  console.log("\nAndroid Pentest Lab - clean\n");

  // Kill any lingering emulator/qemu processes by name FIRST — right after
  // `adb emu kill`, a lingering qemu-system process can still hold file
  // handles under tools/cache, producing EBUSY on the very next line if we
  // try to delete it while the process is still exiting.
  log.step("Stopping emulator processes");
  if (platform.type === "windows") {
    run("powershell.exe", [
      "-NoProfile", "-Command",
      "Get-Process -Name 'qemu-system-*','emulator' -ErrorAction SilentlyContinue | Stop-Process -Force",
    ]);
  } else {
    run("pkill", ["-f", "qemu-system"]);
    run("pkill", ["-f", "/emulator"]);
  }
  Bun.sleepSync(1_500);

  log.step("Deleting AVDs");
  const sdkRoot = cfg.sdkRoot;
  if (existsSync(sdkRoot)) {
    const emuPath = emulatorPath(sdkRoot, platform);
    if (existsSync(emuPath)) {
      const avdmgr = avdmanagerPath(sdkRoot, platform);
      for (const name of [cfg.avdName, cfg.sourceAvdName]) {
        if (listAvds(emuPath).includes(name)) {
          run(avdmgr, ["delete", "avd", "--name", name]);
          log.good(`Deleted AVD: ${name}`);
        }
      }
    }
  }

  log.step("Deleting downloaded tools");
  removeDirWithRetry(cfg.toolsDir, "tools directory");

  log.good("Clean complete. Run 'bun run init -- --install-sdk' to rebuild from scratch.");
}

export function printLabHelp(): void {
  console.log(`
Android Pentest Lab - lab command

Usage
  bun run init -- [options]       Initialize target and source emulators
  bun run run  -- --package=<pkg> Install, proxy (Burp by default), launch, and attach Frida
  bun run clean                   Delete this lab's AVDs and downloaded tools

Other utility commands
  bun run transfer -- --package=<pkg>   Copy an app between two connected devices
  bun run apkinfo -- <path-to.apk>      Read package name / version / main activity from an APK
  bun run verify                        Quick connectivity check
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
    else if (command === "clean") printCleanHelp();
    else printLabHelp();
    return;
  }
  const labRoot = `${import.meta.dir}/..`;
  switch (command) {
    case "init":
      await initializeLab(labRoot, args);
      return;
    case "clean":
      await cleanLab(labRoot, args);
      return;
    default:
      throw new Error(`Unknown lab command '${command}'. Use: bun run help`);
  }
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});

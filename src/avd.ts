// ── AVD management (create · start · wait) ────────────────────────────────────
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./log.ts";
import { run, runLive } from "./exec.ts";
import { avdmanagerPath, emulatorPath, sdkmanagerPath, systemImageInstalled } from "./sdk.ts";
import type { LabConfig } from "./config.ts";
import type { PlatformInfo } from "./platform.ts";

// ── AVD discovery ─────────────────────────────────────────────────────────────

/** Return all AVD names known to the emulator. */
export function listAvds(emuPath: string): string[] {
  const r = run(emuPath, ["-list-avds"]);
  return r.stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

/** True if an AVD with the given name exists. */
export function avdExists(name: string, emuPath: string): boolean {
  return listAvds(emuPath).includes(name);
}

// ── Device profile resolution ──────────────────────────────────────────────────

/**
 * Return every device id `avdmanager create avd --device <id>` will accept
 * on this SDK install, e.g. ["pixel_7_pro", "pixel_tablet", ...].
 *
 * This list is NOT the same across machines: the "command-line tools only"
 * package this project auto-downloads ships an older, fixed
 * device-definition list, while Android Studio bundles a newer one. A
 * device id that's valid on a Studio-managed SDK (e.g. a literal
 * "pixel_10_pro") can be completely absent on a freshly auto-installed one.
 */
function listDeviceIds(avdmgr: string): string[] {
  const r = run(avdmgr, ["list", "device"]);
  const ids: string[] = [];
  const re = /id:\s*\d+\s+or\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r.stdout))) ids.push(m[1]);
  return ids;
}

/**
 * Resolve a device profile id for `avdmanager create avd --device <id>`,
 * falling back gracefully instead of hard-failing when `preferred` isn't on
 * this SDK's device list (see listDeviceIds() above for why that happens).
 *
 * Fallback order: the exact preferred id -> the newest available
 * "pixel_*_pro" -> the newest available "pixel_*" -> the first device id
 * this avdmanager knows about at all.
 */
export function resolveDeviceProfile(avdmgr: string, preferred: string): string {
  const ids = listDeviceIds(avdmgr);
  if (ids.length === 0) return preferred; // avdmanager list failed to parse — let create avd surface the real error

  if (ids.includes(preferred)) return preferred;

  const byNewestPixelNumber = (candidates: string[]) => candidates
    .map(id => ({ id, n: parseInt(id.match(/pixel_(\d+)/)?.[1] ?? "-1", 10) }))
    .sort((a, b) => b.n - a.n)[0]?.id;

  const pixelPro = byNewestPixelNumber(ids.filter(id => /^pixel_\d+.*_pro$/.test(id)));
  const pixelAny = byNewestPixelNumber(ids.filter(id => /^pixel_\d+/.test(id)));
  const fallback = pixelPro ?? pixelAny ?? ids[0];

  log.warn(`Device profile '${preferred}' is not on this SDK's device list — using '${fallback}' instead.`);
  return fallback;
}

// ── AVD creation ──────────────────────────────────────────────────────────────

/**
 * Create an AVD matching the lab config.
 * Skips silently if the AVD already exists, unless `cfg.forceAvd` is set.
 *
 * After creation, writes a hardware config with the RAM / core / disk values
 * from the config so the emulator uses them by default.
 */
export async function ensureAvd(
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<void> {
  log.step("AVD");

  const emuPath = emulatorPath(cfg.sdkRoot, platform);
  if (!existsSync(emuPath)) {
    throw new Error(
      `emulator not found: ${emuPath}\n` +
      "Run bootstrap with --install-sdk to install the Android Emulator.",
    );
  }

  if (!systemImageInstalled(cfg)) {
    if (!cfg.installSdk) {
      throw new Error(
        `Required system image is missing: android-${cfg.apiLevel};${cfg.systemImageTag};${cfg.abi}\n` +
        "Rerun with: bun run init -- --install-sdk",
      );
    }
    const imagePackage = `system-images;android-${cfg.apiLevel};${cfg.systemImageTag};${cfg.abi}`;
    log.info(`Installing missing target system image: ${imagePackage}`);
    // See src/sdk.ts installHeadlessSdk() for why --sdk_root=<path> must
    // never be passed on sdkmanager.bat's argv when <path> contains a
    // space — ANDROID_SDK_ROOT/ANDROID_HOME env vars carry it instead.
    const result = await runLive(sdkmanagerPath(cfg.sdkRoot, platform), [
      "--install", imagePackage,
    ], { env: { ANDROID_SDK_ROOT: cfg.sdkRoot, ANDROID_HOME: cfg.sdkRoot } });
    if (result !== 0 || !systemImageInstalled(cfg)) {
      throw new Error(`Could not install required system image: ${imagePackage}`);
    }
    log.good("Target system image installed.");
  }

  if (avdExists(cfg.avdName, emuPath)) {
    if (!cfg.forceAvd) {
      log.good(`AVD already exists: ${cfg.avdName}`);
      return;
    }
    log.warn(`--force-avd set — deleting existing AVD '${cfg.avdName}' and recreating.`);
    deleteAvd(cfg.avdName, cfg.sdkRoot, platform);
  }

  const avdmgr = avdmanagerPath(cfg.sdkRoot, platform);
  const deviceId = resolveDeviceProfile(avdmgr, cfg.deviceProfile);

  log.info(`Creating AVD: ${cfg.avdName}`);
  log.info(`  system image: android-${cfg.apiLevel}  ${cfg.systemImageTag}/${cfg.abi}`);
  log.info(`  device profile: ${deviceId}`);

  const pkg = `system-images;android-${cfg.apiLevel};${cfg.systemImageTag};${cfg.abi}`;

  const r = run(avdmgr, [
    "create", "avd",
    "--name",    cfg.avdName,
    "--package", pkg,
    "--device",  deviceId,
    "--force",
  ]);

  // avdmanager prompts "Do you wish to create a custom hardware profile?" — answer no.
  // If it was interactive, the run above captured it; the default (no custom profile) is fine.
  if (!r.ok && !r.stdout.includes("created")) {
    throw new Error(`avdmanager failed:\n${r.stderr.trim() || r.stdout.trim()}`);
  }

  log.good(`AVD created: ${cfg.avdName}`);
  applyHardwareConfig(cfg);
}

function deleteAvd(name: string, sdkRoot: string, platform: PlatformInfo): void {
  const avdmgr = avdmanagerPath(sdkRoot, platform);
  run(avdmgr, ["delete", "avd", "--name", name]);
}

/**
 * Write hardware config values (RAM, cores, disk, sd-card) to the AVD's
 * config.ini so the emulator picks them up without extra CLI flags.
 */
function applyHardwareConfig(cfg: LabConfig): void {
  // Respect ANDROID_AVD_HOME (used to relocate AVD storage, e.g. for an
  // isolated/sandboxed lab run) instead of always assuming the default
  // ~/.android/avd — otherwise this silently no-ops whenever AVDs live
  // somewhere else, leaving the configured RAM/cores/disk unapplied.
  const avdBase = process.env.ANDROID_AVD_HOME || join(homedir(), ".android", "avd");
  const avdHome = join(avdBase, `${cfg.avdName}.avd`);
  const configFile = join(avdHome, "config.ini");

  if (!existsSync(configFile)) {
    log.warn(`Hardware config not found: ${configFile} (skipping custom RAM/disk)`);
    return;
  }

  let ini = readFileSync(configFile, "utf8");

  function setKey(key: string, value: string): void {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(ini)) {
      ini = ini.replace(re, `${key}=${value}`);
    } else {
      ini += `\n${key}=${value}`;
    }
  }

  setKey("hw.ramSize",         String(cfg.avdRamMb));
  setKey("hw.cpu.ncore",       String(cfg.avdCores));
  setKey("disk.dataPartition.size", `${cfg.avdDiskMb}M`);
  setKey("sdcard.size",        `${cfg.avdSdCardMb}M`);

  writeFileSync(configFile, ini, "utf8");
  log.good(`Hardware config written (${cfg.avdRamMb} MB RAM, ${cfg.avdCores} cores).`);
}

// ── Emulator launch ───────────────────────────────────────────────────────────

/**
 * Start the emulator in the background with no visible window.
 *
 * On Windows: delegates to PowerShell `Start-Process -WindowStyle Hidden` so
 *             no console window flashes.
 * On Linux/WSL/macOS: spawns with ignored stdio so the parent can exit freely.
 *
 * Returns the PID of the emulator process (best-effort; 0 if not determinable).
 *
 * @param gpuModeOverride  Force a specific `-gpu` mode instead of
 *   `cfg.gpuMode` — used by the boot-timeout retry to force
 *   "swiftshader_indirect" after a suspected GPU-init failure (black
 *   screen), without changing the user's configured default.
 */
export async function startEmulator(
  cfg: LabConfig,
  platform: PlatformInfo,
  gpuModeOverride?: string,
): Promise<number> {
  const emuPath = emulatorPath(cfg.sdkRoot, platform);
  const args = [
    "-avd",         cfg.avdName,
    "-no-boot-anim",
    "-no-audio",
    "-gpu",         gpuModeOverride ?? cfg.gpuMode,
  ];

  log.info(`Launching emulator: ${cfg.avdName}`);

  if (platform.type === "windows") {
    // PowerShell Start-Process: window hidden, returns PID via -PassThru.
    const argStr = args.map(a => `'${a}'`).join(",");
    const ps = `(Start-Process -FilePath '${emuPath}' -ArgumentList ${argStr} -WindowStyle Hidden -PassThru).Id`;
    const r = run("powershell", ["-NoProfile", "-Command", ps]);
    const pid = parseInt(r.stdout.trim(), 10);
    log.good(`Emulator started (Windows, PID=${isNaN(pid) ? "?" : pid}).`);
    return isNaN(pid) ? 0 : pid;
  }

  // Linux / macOS / WSL — Bun.spawn with ignored stdio.
  // Bun does not kill un-reaped children on exit, so the emulator stays alive.
  const proc = Bun.spawn([emuPath, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    stdin:  "ignore",
  });
  log.good(`Emulator started (PID=${proc.pid}).`);
  return proc.pid;
}

/**
 * Ask a running emulator to shut down via its ADB console ("emu kill"),
 * rather than tracking/killing an OS PID — works the same on every platform
 * and doesn't care whether the process was launched via PowerShell
 * Start-Process or Bun.spawn. Used by the boot-timeout GPU-mode retry.
 * Best-effort: failures here are not fatal, the caller just relaunches.
 */
export function killEmulator(adbPath: string, serial: string): void {
  run(adbPath, ["-s", serial, "emu", "kill"]);
}

// ── AVD management (create · start · wait) ────────────────────────────────────
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./log.ts";
import { run, runOrFail, runLive } from "./exec.ts";
import { avdmanagerPath, emulatorPath } from "./sdk.ts";
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

// ── AVD creation ──────────────────────────────────────────────────────────────

/**
 * Create an AVD matching the lab config.
 * Skips silently if the AVD already exists, unless `cfg.forceAvd` is set.
 *
 * After creation, writes a hardware config with the RAM / core / disk values
 * from the config so the emulator uses them by default.
 */
export function ensureAvd(
  cfg: LabConfig,
  platform: PlatformInfo,
): void {
  log.step("AVD");

  const emuPath = emulatorPath(cfg.sdkRoot, platform);
  if (!existsSync(emuPath)) {
    throw new Error(
      `emulator not found: ${emuPath}\n` +
      "Run bootstrap with --install-sdk to install the Android Emulator.",
    );
  }

  if (avdExists(cfg.avdName, emuPath)) {
    if (!cfg.forceAvd) {
      log.good(`AVD already exists: ${cfg.avdName}`);
      return;
    }
    log.warn(`--force-avd set — deleting existing AVD '${cfg.avdName}' and recreating.`);
    deleteAvd(cfg.avdName, cfg.sdkRoot, platform);
  }

  log.info(`Creating AVD: ${cfg.avdName}`);
  log.info(`  system image: android-${cfg.apiLevel}  ${cfg.systemImageTag}/${cfg.abi}`);
  log.info(`  device profile: ${cfg.deviceProfile}`);

  const avdmgr = avdmanagerPath(cfg.sdkRoot, platform);
  const pkg = `system-images;android-${cfg.apiLevel};${cfg.systemImageTag};${cfg.abi}`;

  const r = run(avdmgr, [
    "create", "avd",
    "--name",    cfg.avdName,
    "--package", pkg,
    "--device",  cfg.deviceProfile,
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
  const avdHome = join(homedir(), ".android", "avd", `${cfg.avdName}.avd`);
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
 */
export async function startEmulator(
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<number> {
  const emuPath = emulatorPath(cfg.sdkRoot, platform);
  const args = [
    "-avd",         cfg.avdName,
    "-no-boot-anim",
    "-no-audio",
    "-gpu",         "host",
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

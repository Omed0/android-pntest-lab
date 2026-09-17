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
      // Reapply unconditionally, same as the source AVD in lab.ts — an AVD
      // created before this GPU fix existed (or with GPU otherwise disabled)
      // would otherwise never get hw.gpu.enabled=yes just by being reused.
      applyGpuConfig(cfg.avdName);
      lockEmulatorWindow(cfg, cfg.avdName, platform);
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
  lockEmulatorWindow(cfg, cfg.avdName, platform);
}

function deleteAvd(name: string, sdkRoot: string, platform: PlatformInfo): void {
  const avdmgr = avdmanagerPath(sdkRoot, platform);
  run(avdmgr, ["delete", "avd", "--name", name]);
}

/**
 * Resolve an AVD's data directory, respecting ANDROID_AVD_HOME (used to
 * relocate AVD storage, e.g. for an isolated/sandboxed lab run) instead of
 * always assuming the default ~/.android/avd.
 */
function avdHomeDir(avdName: string): string {
  const avdBase = process.env.ANDROID_AVD_HOME || join(homedir(), ".android", "avd");
  return join(avdBase, `${avdName}.avd`);
}

/**
 * Write hardware config values (RAM, cores, disk, sd-card) to the AVD's
 * config.ini so the emulator picks them up without extra CLI flags.
 */
function applyHardwareConfig(cfg: LabConfig): void {
  const avdHome = avdHomeDir(cfg.avdName);
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

  // GPU must be enabled separately (see applyGpuConfig) — do it for the
  // target AVD here right after its other hardware config.
  applyGpuConfig(cfg.avdName);
}

/**
 * Enable GPU emulation on an AVD's config.ini (hw.gpu.enabled=yes,
 * hw.gpu.mode=auto), and enable host-keyboard passthrough (hw.keyboard=yes).
 *
 * GPU: this MUST be set or the emulator falls back to a broken guest
 * software renderer that shows a solid black/white/grey screen (and boots
 * much slower, often past the boot timeout) — the actual root cause of both
 * the "black screen" and the "source AVD times out" problems on this
 * project's machine. `avdmanager create avd` (headless) defaults
 * hw.gpu.enabled=no, unlike Android Studio's AVD wizard which writes
 * yes/auto.
 *
 * Keyboard: `avdmanager create avd` (headless) also defaults
 * hw.keyboard=no for phone profiles — with that set, Android treats no
 * physical keyboard as present and only accepts input via the on-screen
 * soft keyboard, so the host's own keyboard does nothing when typing into a
 * focused field. Setting hw.keyboard=yes makes the emulator forward host
 * keystrokes as real hardware key events, which is what a lab actually
 * needs (typing search queries, Play Store sign-in, app text fields).
 *
 * Applying both to *every* AVD the lab uses (target AND the Play Store
 * source) is safe to call repeatedly and on an already-existing AVD.
 */
export function applyGpuConfig(avdName: string): void {
  const configFile = join(avdHomeDir(avdName), "config.ini");
  if (!existsSync(configFile)) {
    log.warn(`config.ini not found for ${avdName} — cannot apply GPU/keyboard config (${configFile}).`);
    return;
  }
  let ini = readFileSync(configFile, "utf8");
  const setKey = (key: string, value: string) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    ini = re.test(ini) ? ini.replace(re, `${key}=${value}`) : ini + `\n${key}=${value}`;
  };
  setKey("hw.gpu.enabled", "yes");
  setKey("hw.gpu.mode",    "auto");
  setKey("hw.keyboard",    "yes");
  writeFileSync(configFile, ini, "utf8");
  log.good(`GPU + host keyboard enabled for AVD: ${avdName}`);
}

/**
 * The emulator's window enforces `window.scale` as a hard max size, not just
 * an initial size — confirmed directly: Win32 `ShowWindow(SW_SHOWMAXIMIZED)`
 * on this window has NO effect at all (size and placement state unchanged)
 * when a scale is locked, because the app itself refuses to grow past it.
 * So "bring it up maximized" has to mean "lock a scale that actually fills
 * the real screen", not an OS-level maximize call — and it has to be
 * measured on THIS machine every time, never a guessed constant (confirmed:
 * a fixed 0.3 already overflowed a real 1280x752 work area seen on this
 * project's own machine, and a fixed fallback would be just as wrong on a
 * different one).
 *
 * Two independent, purely dynamic measurements, tried in order:
 *   1. .NET `Screen.PrimaryScreen.WorkingArea` — excludes the taskbar, the
 *      more accurate figure when available.
 *   2. Raw Win32 `GetSystemMetrics(SM_CXSCREEN=0, SM_CYSCREEN=1)` — the full
 *      screen resolution (no taskbar exclusion), available on effectively
 *      any Windows session with a display even where System.Windows.Forms
 *      can't load. Still a real, live measurement, not a guess.
 * Returns null (never a hardcoded number) if BOTH genuinely fail.
 */
function windowsWorkArea(): { width: number; height: number } | null {
  if (process.platform !== "win32") return null;

  const viaForms = run("powershell", [
    "-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; \"$($a.Width)x$($a.Height)\"",
  ]);
  let m = viaForms.stdout.trim().match(/^(\d+)x(\d+)$/);
  if (viaForms.ok && m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };

  const viaGdi = run("powershell", [
    "-NoProfile", "-Command",
    `Add-Type @"
using System.Runtime.InteropServices;
public class LabMetrics { [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n); }
"@
"$([LabMetrics]::GetSystemMetrics(0))x$([LabMetrics]::GetSystemMetrics(1))"`,
  ]);
  m = viaGdi.stdout.trim().match(/^(\d+)x(\d+)$/);
  if (viaGdi.ok && m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };

  return null;
}

/**
 * Pin the emulator window to a fixed position/scale and lock it read-only,
 * so the emulator can't overwrite it with wherever the window happened to
 * be on last clean shutdown (it rewrites emulator-user.ini every time).
 * Safe to call every run: strips read-only, rewrites the same values,
 * re-locks — a no-op in effect once already applied. No-op entirely if
 * `cfg.lockWindow` is false.
 *
 * `cfg.windowScale <= 0` (the default) means "auto-fit": measure THIS
 * machine's actual screen (see windowsWorkArea()) and the AVD's own real
 * device resolution (hw.lcd.width/height from its config.ini — never
 * assumed), then compute the largest scale that fits the device's full
 * width AND height within ~92% of the screen, capped at native size
 * (1.0). If either real measurement is unavailable, `window.scale` is left
 * unset entirely (the emulator's own default) instead of substituting a
 * guessed number — this must reflect the actual screen and actual device,
 * not a static human-picked constant. Pass an explicit
 * --window-scale=<n> (n > 0) to override with a literal scale instead.
 */
export function lockEmulatorWindow(cfg: LabConfig, avdName: string, platform: PlatformInfo): void {
  if (!cfg.lockWindow) return;

  const avdHome = avdHomeDir(avdName);
  const iniPath = join(avdHome, "emulator-user.ini");

  if (!existsSync(avdHome)) return; // AVD doesn't exist yet — nothing to lock

  let scale: number | null = cfg.windowScale > 0 ? cfg.windowScale : null;
  let autoFit = false;
  if (scale === null) {
    const configPath = join(avdHome, "config.ini");
    const workArea = windowsWorkArea();
    const configIni = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const lcdHeight = parseInt(configIni.match(/^hw\.lcd\.height\s*=\s*(\d+)/m)?.[1] ?? "", 10);
    const lcdWidth = parseInt(configIni.match(/^hw\.lcd\.width\s*=\s*(\d+)/m)?.[1] ?? "", 10);
    if (workArea && !isNaN(lcdHeight) && lcdHeight > 0 && !isNaN(lcdWidth) && lcdWidth > 0) {
      const margin = 0.92;
      const byHeight = (workArea.height * margin) / lcdHeight;
      const byWidth = (workArea.width * margin) / lcdWidth;
      scale = Math.min(1.0, byHeight, byWidth);
      autoFit = true;
    } else {
      log.warn(`Could not measure screen/device size for ${avdName} — leaving window.scale unset (emulator default) instead of guessing.`);
    }
  }

  if (platform.type === "windows") run("attrib", ["-R", iniPath]);
  else run("chmod", ["644", iniPath]);

  // Preserve an existing uuid (if the emulator already ran once and wrote
  // one) so AVD Manager/the emulator keep recognizing this AVD instance.
  let existingUuid: string | null = null;
  if (existsSync(iniPath)) {
    const match = readFileSync(iniPath, "utf8").match(/^uuid\s*=\s*(.+)$/m);
    if (match) existingUuid = match[1].trim();
  }

  const lines = [
    `window.x = ${cfg.windowX}`,
    `window.y = ${cfg.windowY}`,
    ...(scale !== null ? [`window.scale = ${scale.toFixed(6)}`] : []),
    "resizable.config.id = -1",
    "posture = 0",
  ];
  if (existingUuid) lines.push(`uuid = ${existingUuid}`);

  writeFileSync(iniPath, lines.join("\n") + "\n", "utf8");

  if (platform.type === "windows") run("attrib", ["+R", iniPath]);
  else run("chmod", ["444", iniPath]);

  log.good(
    scale !== null
      ? `Emulator window locked: x=${cfg.windowX} y=${cfg.windowY} scale=${scale.toFixed(3)}${autoFit ? " (measured, auto-fit)" : ""}`
      : `Emulator window position locked: x=${cfg.windowX} y=${cfg.windowY} (scale left to the emulator's own default)`,
  );
}

// ── Emulator launch ───────────────────────────────────────────────────────────

/**
 * Launch the emulator on Windows via PowerShell `Start-Process`, returning
 * its PID.
 *
 * `emulator.exe` is a console-subsystem binary. Redirecting its stdio alone
 * (a prior attempt) does NOT stop Windows from allocating it a console
 * window — confirmed directly, the window still appeared, just empty since
 * the text was going to the redirected log files instead. `-WindowStyle`
 * only controls the show-state of whatever window is allocated; it cannot
 * suppress the console window's *creation*. `-NoNewWindow` is the actual
 * PowerShell switch for that (maps to a plain CreateProcess with no console
 * allocated at all) — it reuses/attaches to no console rather than opening
 * one, while the emulator's own separate Qt/skin display window is
 * unaffected (window creation, not console allocation) and still shows.
 * `-NoNewWindow` and `-WindowStyle` are mutually exclusive PowerShell
 * parameters, so `showWindow=false` still needs the old `-WindowStyle
 * Hidden` path (which hides the display window too — that's the intent of
 * "hidden").
 */
export function launchWindowsEmulator(
  emuPath: string,
  args: string[],
  avdName: string,
  cacheDir: string,
  showWindow: boolean,
): number {
  mkdirSync(cacheDir, { recursive: true });
  const stdoutLog = join(cacheDir, `emulator-${avdName}.stdout.log`);
  const stderrLog = join(cacheDir, `emulator-${avdName}.stderr.log`);
  const argStr = args.map(a => `'${a}'`).join(",");
  const windowFlag = showWindow ? "-NoNewWindow" : "-WindowStyle Hidden";
  const ps = `(Start-Process -FilePath '${emuPath}' -ArgumentList ${argStr} ` +
    `-RedirectStandardOutput '${stdoutLog}' -RedirectStandardError '${stderrLog}' ` +
    `${windowFlag} -PassThru).Id`;
  const r = run("powershell", ["-NoProfile", "-Command", ps]);
  const pid = parseInt(r.stdout.trim(), 10);
  return isNaN(pid) ? 0 : pid;
}

/**
 * Start the emulator in the background.
 *
 * On Windows: delegates to PowerShell `Start-Process -PassThru`, visible by
 *             default (`cfg.showWindow`) so first-run interaction (Play
 *             Store sign-in, manually using an app to generate traffic)
 *             doesn't require hunting for a hidden window; pass
 *             `--no-show-window` to go back to a hidden launch.
 * On Linux/WSL/macOS: spawns with ignored stdio so the parent can exit freely
 *             (window visibility there is up to the desktop environment).
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
    // Always cold-boot and never save/load a boot snapshot. A snapshot saved
    // from an emulator that was force-killed mid-shutdown (which happened
    // repeatedly during debugging) restores into a half-ready state:
    // sys.boot_completed never flips to 1, `adb shell` returns empty, and
    // screencap fails — which then broke the root check and renderer check.
    // Cold-booting every time is a bit slower but reliable and reproducible,
    // which is what a lab wants.
    "-no-snapshot",
    "-gpu",         gpuModeOverride ?? cfg.gpuMode,
    // NOTE: deliberately NOT passing -writable-system. It was confirmed to
    // trigger a broken/hung boot on this project's Android 13 image (boot
    // stalls right after WHPX init, never reaches graphics/boot-complete;
    // removing it boots in ~20-36s with the GPU engaged). The Burp CA is
    // instead installed via a tmpfs overlay on /system/etc/security/cacerts
    // (see Adb.installSystemCert() in src/adb.ts), which needs only `adb
    // root` — no writable-system, no dm-verity disable, no reboot.
  ];

  log.info(`Launching emulator: ${cfg.avdName}`);

  if (platform.type === "windows") {
    const pid = launchWindowsEmulator(emuPath, args, cfg.avdName, cfg.cacheDir, cfg.showWindow);
    log.good(`Emulator started (Windows, PID=${pid || "?"}).`);
    return pid;
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

/**
 * Bring the emulator's Qt display window up, maximized, and keep it there
 * (Windows only).
 *
 * The emulator window (title "Android Emulator - <avd>:<port>", owned by the
 * qemu-system-* process) was observed dropping behind / appearing minimized
 * during a script run — focus-stealing from the many adb/powershell
 * subprocesses in the flow. The user wants it up and maximized the whole
 * time. This maximizes it (ShowWindow SW_SHOWMAXIMIZED=3), forces it to the
 * foreground (a brief HWND_TOPMOST/NOTOPMOST toggle so it actually rises,
 * not just flashes in the taskbar), and is called as the LAST step of each
 * flow (and right before the Frida attach in run.ts) so nothing runs
 * afterward to bury it again. Best-effort; no-op on non-Windows or when the
 * window isn't found. Not left permanently topmost so the user can still
 * click over to Burp/other tools.
 *
 * @param maximize  When true, issue SW_SHOWMAXIMIZED instead of SW_RESTORE.
 *   For the TARGET, lockEmulatorWindow() already pins an explicit
 *   window.scale in emulator-user.ini, which enforces a fixed max size on
 *   the Qt window — confirmed directly that SW_SHOWMAXIMIZED is silently
 *   ignored in that case, so SW_RESTORE (un-minimize) + raise is all that's
 *   used there. The SOURCE AVD deliberately has no window.scale/lock applied
 *   at all (see src/lab.ts initializeLab()), so there's no such constraint —
 *   a real OS-level maximize works and is what's used to size its window
 *   instead of any custom scale math.
 */
export function bringEmulatorWindowToFront(avdName: string, maximize = false): void {
  if (process.platform !== "win32") return;
  const showCmd = maximize ? 3 : 9; // SW_SHOWMAXIMIZED : SW_RESTORE
  // Target the window BY AVD NAME (its title is "Android Emulator -
  // <avd>:<port>"), not just the first qemu window, so with two emulators up
  // we raise the right one. AttachThreadInput to the current foreground
  // thread is what lets SetForegroundWindow take from a background
  // (bun/powershell) process. Retry a few times since the window handle can
  // lag right after boot.
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LabWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@
$raised=$false
for ($i=0; $i -lt 8 -and -not $raised; $i++) {
  $w = Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${avdName}*' } | Select-Object -First 1
  if ($w) {
    $h = $w.MainWindowHandle
    $fg = [LabWin]::GetForegroundWindow()
    $ct = [LabWin]::GetCurrentThreadId()
    $ft = [LabWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    [LabWin]::AttachThreadInput($ft, $ct, $true) | Out-Null
    [LabWin]::ShowWindow($h, ${showCmd}) | Out-Null   # ${maximize ? "SW_SHOWMAXIMIZED" : "SW_RESTORE (un-minimize)"}
    [LabWin]::BringWindowToTop($h) | Out-Null
    [LabWin]::SetForegroundWindow($h) | Out-Null
    [LabWin]::AttachThreadInput($ft, $ct, $false) | Out-Null
    $raised=$true
  } else { Start-Sleep -Milliseconds 800 }
}
if ($raised) { Write-Output "raised" } else { Write-Output "no-window" }`;
  const r = run("powershell", ["-NoProfile", "-Command", ps]);
  if (r.stdout.includes("raised")) log.good(`Emulator window brought to front: ${avdName}`);
  else log.warn(`Could not find the emulator window to raise (${avdName}).`);
}

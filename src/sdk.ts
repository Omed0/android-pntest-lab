// ── Android SDK (headless, cmdline-tools only) ────────────────────────────────
//
// This module installs only what is actually needed:
//   cmdline-tools  (sdkmanager + avdmanager)
//   platform-tools (adb)
//   emulator
//   system-images;android-<api>;<tag>;<abi>
//
// It does NOT install Android Studio, the full IDE, or anything else.
// The download is the same "Command-line tools only" zip from:
//   https://developer.android.com/studio#command-line-tools-only
//
import { existsSync, mkdirSync, renameSync } from "fs";
import { join, basename } from "path";
import { log } from "./log.ts";
import { run, runWithStdin, runLive } from "./exec.ts";
import { downloadFile, extractZip } from "./download.ts";
import type { LabConfig } from "./config.ts";
import type { PlatformInfo } from "./platform.ts";

// ── Cmdline-tools download URLs ───────────────────────────────────────────────

const CMDTOOLS_BASE = "https://dl.google.com/android/repository";

function cmdToolsUrl(version: string, platform: PlatformInfo): string {
  const os = platform.type === "windows" ? "win"
           : platform.type === "macos"   ? "mac"
           :                               "linux";
  return `${CMDTOOLS_BASE}/commandlinetools-${os}-${version}_latest.zip`;
}

// ── sdkmanager / avdmanager paths ────────────────────────────────────────────

function sdkmanagerPath(sdkRoot: string, platform: PlatformInfo): string {
  const ext  = platform.type === "windows" ? ".bat" : "";
  return join(sdkRoot, "cmdline-tools", "latest", "bin", `sdkmanager${ext}`);
}

function avdmanagerPath(sdkRoot: string, platform: PlatformInfo): string {
  const ext = platform.type === "windows" ? ".bat" : "";
  return join(sdkRoot, "cmdline-tools", "latest", "bin", `avdmanager${ext}`);
}

function sdkToolsPresent(root: string, platform: PlatformInfo): boolean {
  const ext = platform.type === "windows" ? ".bat" : "";
  return [
    join(root, "platform-tools", `adb${platform.exe}`),
    join(root, "emulator", `emulator${platform.exe}`),
    join(root, "cmdline-tools", "latest", "bin", `sdkmanager${ext}`),
    join(root, "cmdline-tools", "latest", "bin", `avdmanager${ext}`),
  ].every(existsSync);
}

function sdkRuntimePresent(root: string, platform: PlatformInfo): boolean {
  return [
    join(root, "platform-tools", `adb${platform.exe}`),
    join(root, "emulator", `emulator${platform.exe}`),
  ].every(existsSync);
}

export { sdkmanagerPath, avdmanagerPath };

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns the SDK root if a valid SDK is already present, otherwise null. */
export function findSdk(cfg: LabConfig, platform: PlatformInfo): string | null {
  const candidates = [
    cfg.sdkRoot,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    platform.sdkDefaultPath,
    // WSL: Windows SDK mounted at /mnt/c/...
    platform.windowsHome
      ? join(platform.windowsHome, "AppData", "Local", "Android", "Sdk")
      : null,
  ].filter((p): p is string => !!p);

  for (const root of candidates) {
    if (sdkRuntimePresent(root, platform)) {
      return root;
    }
  }
  return null;
}

/**
 * Ensure the Android SDK is present.
 * If not found:
 *   - Requires --install-sdk flag (or throws with instructions).
 * Returns the resolved SDK root path.
 */
export async function ensureSdk(
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<string> {
  log.step("Android SDK");

  const existing = findSdk(cfg, platform);
  if (existing) {
    if (!sdkToolsPresent(existing, platform)) {
      if (cfg.installSdk) {
        log.warn("SDK runtime found, but cmdline-tools are incomplete; repairing SDK tools.");
        return installHeadlessSdk(cfg, platform);
      }
      log.warn("SDK runtime found; cmdline-tools are missing. Existing AVDs can run, but creating new AVDs requires --install-sdk.");
    }
    log.good(`SDK found: ${existing}`);
    return existing;
  }

  if (!cfg.installSdk) {
    throw new Error(
      "Android SDK not found.\n\n" +
      "Option A — use an existing installation:\n" +
      "  bun run bootstrap -- --sdk-root=\"C:\\Users\\you\\AppData\\Local\\Android\\Sdk\"\n\n" +
      "Option B — let this script install cmdline-tools automatically:\n" +
      "  bun run init -- --install-sdk\n\n" +
      "Option C — install Android Studio (full IDE):\n" +
      "  https://developer.android.com/studio",
    );
  }

  return installHeadlessSdk(cfg, platform);
}

// ── Headless SDK installation ─────────────────────────────────────────────────

async function installHeadlessSdk(
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<string> {
  log.info("Installing Android cmdline-tools (headless)…");

  const sdkRoot  = cfg.sdkRoot || join(cfg.toolsDir, "android-sdk");
  const cacheDir = cfg.cacheDir;
  mkdirSync(sdkRoot,  { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  // 1. Download cmdline-tools zip
  const url      = cmdToolsUrl(cfg.cmdlineToolsVersion, platform);
  const zipFile  = join(cacheDir, basename(url));
  await downloadFile(url, zipFile);

  // 2. Extract to a temp dir, then move to the correct location.
  //    Google's zip extracts as: cmdline-tools/
  //    SDK expects it at:        sdkRoot/cmdline-tools/latest/
  const tmpDir = join(sdkRoot, "_cmdtools_tmp");
  mkdirSync(tmpDir, { recursive: true });
  extractZip(zipFile, tmpDir, platform);

  const latestDest = join(sdkRoot, "cmdline-tools", "latest");
  mkdirSync(join(sdkRoot, "cmdline-tools"), { recursive: true });

  const extracted = join(tmpDir, "cmdline-tools");
  if (existsSync(latestDest)) {
    // Overwrite: remove old one first
    run("rm", ["-rf", latestDest]);          // Linux/macOS/WSL
    run("powershell", ["-Command", `Remove-Item -Recurse -Force '${latestDest}'`]); // Windows
  }
  renameSync(extracted, latestDest);
  run("rm", ["-rf", tmpDir]);

  log.good("cmdline-tools installed.");

  // 3. Accept SDK licenses
  log.info("Accepting SDK licenses…");
  const sdkm = sdkmanagerPath(sdkRoot, platform);
  await runWithStdin(sdkm, ["--licenses", `--sdk_root=${sdkRoot}`], "y\n".repeat(20));

  // 4. Install required SDK packages
  const sysImage = `system-images;android-${cfg.apiLevel};${cfg.systemImageTag};${cfg.abi}`;
  const packages = ["platform-tools", "emulator", sysImage];

  log.info("Installing SDK packages:");
  packages.forEach(p => log.info(`  ${p}`));

  const code = await runLive(sdkm, [
    `--sdk_root=${sdkRoot}`,
    "--install",
    ...packages,
  ]);

  if (code !== 0) throw new Error("sdkmanager failed installing packages.");
  log.good("SDK packages installed.");

  return sdkRoot;
}

// ── System image check ────────────────────────────────────────────────────────

/** True if the required system image is already downloaded. */
export function systemImageInstalled(cfg: LabConfig): boolean {
  const imgPath = join(
    cfg.sdkRoot,
    "system-images",
    `android-${cfg.apiLevel}`,
    cfg.systemImageTag,
    cfg.abi,
    "system.img",
  );
  return existsSync(imgPath);
}

/** Emulator executable path inside the SDK. */
export function emulatorPath(sdkRoot: string, platform: PlatformInfo): string {
  return join(sdkRoot, "emulator", `emulator${platform.exe}`);
}

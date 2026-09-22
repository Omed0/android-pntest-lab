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
import { join, basename, dirname } from "path";
import { log } from "./log.ts";
import { run, runWithStdin, runLive } from "./exec.ts";
import {
  downloadFile,
  extractZip,
  extractZipFlattenRoot,
  ensure7z,
} from "./download.ts";
import type { LabConfig } from "./config.ts";
import type { PlatformInfo } from "./platform.ts";

// ── Java (required by sdkmanager.bat/avdmanager.bat, never checked before) ────

function javaAlreadyWorks(): boolean {
  return (
    run("java", ["-version"]).exitCode === 0 ||
    run("java", ["-version"]).stderr.includes("version")
  );
}

/** Where --portable downloads a private JRE, independent of the host's own Java. */
function portableJavaExe(cfg: LabConfig, platform: PlatformInfo): string {
  return join(cfg.toolsDir, "java", "bin", `java${platform.exe}`);
}

/** Point this process (JAVA_HOME + PATH) at a specific java executable. */
function usePortableJava(javaExe: string): void {
  const binDir = dirname(javaExe);
  process.env.JAVA_HOME = dirname(binDir);
  const sep = process.platform === "win32" ? ";" : ":";
  process.env.PATH = `${binDir}${sep}${process.env.PATH ?? ""}`;
}

/**
 * `sdkmanager`/`avdmanager` are themselves Java programs — their .bat/shell
 * wrappers fail with a plain "JAVA_HOME is not set and no 'java' command
 * could be found" if no JRE/JDK is present. This was previously never
 * checked or installed by this project at all, so a genuinely bare machine
 * (no Java, no Android Studio) would fail at the very first cmdline-tools
 * invocation with a raw batch-script error instead of a clear, actionable
 * message — or, when `--install-sdk`/winget are available, installs one.
 *
 * In `--portable` mode, a JRE is instead downloaded as a plain zip into
 * tools/java/ and used only from there — the host's own Java (if any) is
 * never touched and winget is never invoked.
 */
export async function ensureJava(
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<void> {
  if (cfg.portable) {
    const javaExe = portableJavaExe(cfg, platform);
    if (existsSync(javaExe)) {
      usePortableJava(javaExe);
      return;
    }
    if (platform.type !== "windows") {
      throw new Error(
        "--portable Java install is only implemented for Windows right now.\n" +
          "Install a JRE normally on this platform (e.g. sudo apt install default-jre) and rerun without --portable.",
      );
    }
    log.info(
      "Portable mode: downloading a private JRE into tools/java/ (the host's own Java, if any, is left untouched)…",
    );
    const url =
      "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse";
    const zipFile = join(cfg.cacheDir, "temurin-21-jre-windows-x64.zip");
    await downloadFile(url, zipFile);
    extractZipFlattenRoot(zipFile, join(cfg.toolsDir, "java"), platform, cfg);
    if (!existsSync(javaExe))
      throw new Error(`Portable Java download did not produce ${javaExe}`);
    usePortableJava(javaExe);
    log.good(`Portable Java ready: ${javaExe}`);
    return;
  }

  if (javaAlreadyWorks()) return;

  log.warn("Java runtime not found — required by sdkmanager/avdmanager.");
  if (!cfg.installSdk) {
    throw new Error(
      "Java (JRE/JDK) not found and is required to run the Android cmdline-tools.\n\n" +
        "Install one and rerun, or rerun with --install-sdk to auto-install via winget\n" +
        "(or --portable to download a private copy into this project instead):\n" +
        "  Windows: winget install EclipseAdoptium.Temurin.21.JRE\n" +
        "  Linux:   sudo apt install default-jre\n" +
        "  macOS:   brew install openjdk",
    );
  }

  if (process.platform === "win32" && run("winget", ["--version"]).ok) {
    log.info("Installing a JRE via winget…");
    const code = await runLive("winget", [
      "install",
      "--id",
      "EclipseAdoptium.Temurin.21.JRE",
      "--exact",
      "--silent",
      "--accept-source-agreements",
      "--accept-package-agreements",
    ]);
    if (code === 0 && javaAlreadyWorks()) {
      log.good("Java installed.");
      return;
    }
  }

  throw new Error(
    "Could not find or install Java automatically.\n" +
      "Install a JRE/JDK manually and rerun:\n" +
      "  Windows: winget install EclipseAdoptium.Temurin.21.JRE\n" +
      "  Linux:   sudo apt install default-jre\n" +
      "  macOS:   brew install openjdk",
  );
}

// ── OpenSSL (required for proxy CA generation/verification) ───────────────────

const OPENSSL_WINGET_ID = "ShiningLight.OpenSSL.Light";

function opensslAlreadyWorks(): boolean {
  const r = run("openssl", ["version"]);
  return r.exitCode === 0;
}

/**
 * Add the directory containing OpenSSL to this process' PATH.
 *
 * A winget installation can update the persistent Windows PATH, but the
 * already-running Bun process does not receive that changed environment.
 * Updating process.env.PATH here makes OpenSSL immediately available to
 * proxy.ts and any child processes started during this run.
 */
function useOpenSSL(opensslExe: string): void {
  if (!existsSync(opensslExe)) return;

  const binDir = dirname(opensslExe);
  const sep = process.platform === "win32" ? ";" : ":";
  const currentPath = process.env.PATH ?? "";
  const alreadyInPath = currentPath
    .split(sep)
    .some((entry) => entry && entry.toLowerCase() === binDir.toLowerCase());

  if (!alreadyInPath) {
    process.env.PATH = `${binDir}${sep}${currentPath}`;
  }
}

function findOpenSSL(platform: PlatformInfo): string | null {
  if (opensslAlreadyWorks()) return "openssl";

  // Windows installs commonly seen from OpenSSL Light and Git for Windows.
  // Explicitly checking them matters immediately after a fresh install,
  // because this Bun process inherited the old PATH from the parent shell.
  if (platform.type === "windows") {
    const programFiles =
      process.env.ProgramW6432 ??
      process.env.ProgramFiles ??
      "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

    const candidates = [
      join(programFiles, "OpenSSL-Win64", "bin", "openssl.exe"),
      join(programFiles, "OpenSSL-Win32", "bin", "openssl.exe"),
      join(programFiles, "OpenSSL", "bin", "openssl.exe"),
      join(programFilesX86, "OpenSSL-Win32", "bin", "openssl.exe"),
      join(programFiles, "Git", "usr", "bin", "openssl.exe"),
      join(programFilesX86, "Git", "usr", "bin", "openssl.exe"),
      process.env.LOCALAPPDATA
        ? join(
            process.env.LOCALAPPDATA,
            "Programs",
            "OpenSSL-Win64",
            "bin",
            "openssl.exe",
          )
        : "",
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        useOpenSSL(candidate);
        if (opensslAlreadyWorks()) return candidate;
      }
    }
  }

  return null;
}

/**
 * Ensure OpenSSL is available for proxy CA generation.
 *
 * OpenSSL remains separate from the Android SDK itself, but --install-sdk is
 * the project's existing "install missing prerequisites" switch, so Windows
 * uses winget to install OpenSSL Light when needed.
 *
 * This is intentionally non-fatal: proxy certificate setup already degrades
 * gracefully, and root/Frida/AVD initialization should not be undone by a
 * missing HTTPS interception dependency.
 */
export async function ensureOpenSSL(
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<boolean> {
  // Keep --portable isolated: do not mutate the host or invoke winget for
  // OpenSSL just because a portable SDK was requested.
  if (cfg.portable) return findOpenSSL(platform) !== null;

  if (findOpenSSL(platform)) {
    return true;
  }

  // Preserve the existing non-fatal behavior when the caller did not opt into
  // automatic prerequisite installation.
  if (!cfg.installSdk) {
    return false;
  }

  if (platform.type !== "windows") {
    log.warn(
      "OpenSSL not found — automatic OpenSSL installation via --install-sdk is currently implemented for Windows/winget.\n" +
        "Install OpenSSL with your platform package manager and rerun.",
    );
    return false;
  }

  if (!run("winget", ["--version"]).ok) {
    log.warn(
      "winget not found — cannot auto-install OpenSSL. " +
        "Install OpenSSL manually or install App Installer/winget, then rerun `bun run init -- --install-sdk`.",
    );
    return false;
  }

  log.info("Installing OpenSSL Light via winget…");
  const code = await runLive("winget", [
    "install",
    "--id",
    OPENSSL_WINGET_ID,
    "--exact",
    "--silent",
    "--accept-source-agreements",
    "--accept-package-agreements",
  ]);

  const resolved = findOpenSSL(platform);
  if (code === 0 && resolved) {
    log.good(`OpenSSL ready: ${resolved}`);
    return true;
  }

  log.warn(
    "Could not confirm OpenSSL installed automatically; continuing without HTTPS CA setup. " +
      "Install it manually if Burp/HTTPS interception is required.",
  );
  return false;
}

// ── Android Studio (real, standard install — the opposite of --portable) ──────

/**
 * Install Android Studio via `winget` as a genuinely standard, discoverable
 * app — a real Start Menu entry, shows up in Windows search — deliberately
 * the OPPOSITE of this project's `--portable` pattern for Java/Python/7-Zip,
 * which is intentionally isolated/hidden. This is purely additive: the
 * headless, CLI-managed SDK this project actually uses to drive AVDs/the
 * emulator (ensureSdk() below) is completely independent and unaffected
 * either way, whether or not Android Studio itself is installed.
 *
 * No-op if already installed, if not on Windows, if `--no-android-studio`
 * was passed, or if `--install-sdk` wasn't set (installing a multi-GB GUI
 * IDE should never happen silently without that opt-in, same as every other
 * auto-install in this file).
 */
export async function ensureAndroidStudio(cfg: LabConfig): Promise<void> {
  if (!cfg.androidStudio || process.platform !== "win32") return;

  const installedPath = join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "Android",
    "Android Studio",
    "bin",
    "studio64.exe",
  );
  if (existsSync(installedPath)) {
    log.good("Android Studio already installed.");
    return;
  }

  if (!cfg.installSdk) return; // don't nag about a multi-GB IDE without the install opt-in

  if (!run("winget", ["--version"]).ok) {
    log.warn(
      "winget not found — skipping Android Studio install (--no-android-studio to silence this).",
    );
    return;
  }

  log.info(
    "Installing Android Studio via winget (this is a normal, Start-Menu-visible install, not a portable copy)…",
  );
  const code = await runLive("winget", [
    "install",
    "--id",
    "Google.AndroidStudio",
    "--exact",
    "--silent",
    "--accept-source-agreements",
    "--accept-package-agreements",
  ]);
  if (code === 0 && existsSync(installedPath)) {
    log.good(
      "Android Studio installed — it will now show up in Windows search / Start Menu.",
    );
  } else {
    log.warn(
      "Could not confirm Android Studio installed via winget; continuing without it (the CLI-managed SDK/AVDs are unaffected). Install manually with: winget install Google.AndroidStudio",
    );
  }
}

// ── Cmdline-tools download URLs ───────────────────────────────────────────────

const CMDTOOLS_BASE = "https://dl.google.com/android/repository";

function cmdToolsUrl(version: string, platform: PlatformInfo): string {
  const os =
    platform.type === "windows"
      ? "win"
      : platform.type === "macos"
        ? "mac"
        : "linux";
  return `${CMDTOOLS_BASE}/commandlinetools-${os}-${version}_latest.zip`;
}

// ── sdkmanager / avdmanager paths ────────────────────────────────────────────

function sdkmanagerPath(sdkRoot: string, platform: PlatformInfo): string {
  const ext =
    platform.type === "windows" || platform.type === "wsl" ? ".bat" : "";
  return join(sdkRoot, "cmdline-tools", "latest", "bin", `sdkmanager${ext}`);
}

function avdmanagerPath(sdkRoot: string, platform: PlatformInfo): string {
  const ext =
    platform.type === "windows" || platform.type === "wsl" ? ".bat" : "";
  return join(sdkRoot, "cmdline-tools", "latest", "bin", `avdmanager${ext}`);
}

function sdkToolsPresent(root: string, platform: PlatformInfo): boolean {
  const ext =
    platform.type === "windows" || platform.type === "wsl" ? ".bat" : "";
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

/**
 * Returns the SDK root if a valid SDK is already present, otherwise null.
 *
 * In --portable mode, only `cfg.sdkRoot` (already forced to a private path
 * under tools/ by loadConfig(), unless the user passed an explicit
 * --sdk-root) is considered — the host's own ANDROID_HOME/ANDROID_SDK_ROOT/
 * default-path SDK, if any, is deliberately never auto-detected here, so a
 * portable run never silently borrows (or risks touching) it.
 */
export function findSdk(cfg: LabConfig, platform: PlatformInfo): string | null {
  const candidates = cfg.portable
    ? [cfg.sdkRoot]
    : [
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
  await ensureJava(cfg, platform);
  await ensure7z(cfg, platform);
  await ensureOpenSSL(cfg, platform);
  await ensureAndroidStudio(cfg);

  const existing = findSdk(cfg, platform);
  if (existing) {
    if (!sdkToolsPresent(existing, platform)) {
      if (cfg.installSdk) {
        log.warn(
          "SDK runtime found, but cmdline-tools are incomplete; repairing SDK tools.",
        );
        return installHeadlessSdk(cfg, platform);
      }
      log.warn(
        "SDK runtime found; cmdline-tools are missing. Existing AVDs can run, but creating new AVDs requires --install-sdk.",
      );
    }
    log.good(`SDK found: ${existing}`);
    return existing;
  }

  if (!cfg.installSdk) {
    throw new Error(
      "Android SDK not found.\n\n" +
        "Option A — use an existing installation:\n" +
        '  bun run init -- --sdk-root="C:\\Users\\you\\AppData\\Local\\Android\\Sdk"\n\n' +
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

  const sdkRoot = cfg.sdkRoot || join(cfg.toolsDir, "android-sdk");
  const cacheDir = cfg.cacheDir;
  mkdirSync(sdkRoot, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  // 1. Download cmdline-tools zip
  const url = cmdToolsUrl(cfg.cmdlineToolsVersion, platform);
  const zipFile = join(cacheDir, basename(url));
  await downloadFile(url, zipFile);

  // 2. Extract to a temp dir, then move to the correct location.
  //    Google's zip extracts as: cmdline-tools/
  //    SDK expects it at:        sdkRoot/cmdline-tools/latest/
  const tmpDir = join(sdkRoot, "_cmdtools_tmp");
  mkdirSync(tmpDir, { recursive: true });
  extractZip(zipFile, tmpDir, platform, cfg);

  const latestDest = join(sdkRoot, "cmdline-tools", "latest");
  mkdirSync(join(sdkRoot, "cmdline-tools"), { recursive: true });

  const extracted = join(tmpDir, "cmdline-tools");
  if (existsSync(latestDest)) {
    // Overwrite: remove old one first
    run("rm", ["-rf", latestDest]); // Linux/macOS/WSL
    run("powershell", [
      "-Command",
      `Remove-Item -Recurse -Force '${latestDest}'`,
    ]); // Windows
  }
  // Freshly-extracted files can still be transiently locked on Windows
  // (antivirus real-time scan of the newly written jars/exes) — retry the
  // rename a few times instead of failing the whole SDK install outright.
  // Same class of issue as the archive-lock retry in download.ts.
  for (let i = 0; ; i++) {
    try {
      renameSync(extracted, latestDest);
      break;
    } catch (e) {
      const isLock =
        e instanceof Error &&
        /EPERM|EBUSY/.test((e as NodeJS.ErrnoException).code ?? "");
      if (!isLock || i >= 5) throw e;
      log.warn(`Extracted files still locked, retrying move (${i + 1}/5)…`);
      Bun.sleepSync(1_500);
    }
  }
  run("rm", ["-rf", tmpDir]);

  log.good("cmdline-tools installed.");

  // 3. Accept SDK licenses
  //
  // IMPORTANT: do not pass `--sdk_root=<path>` on the sdkmanager.bat command
  // line on Windows when <path> contains a space (e.g. a repo checked out
  // under "...\mobile app\..."). Spawning a .bat file always goes through
  // cmd.exe, and empirically an argument value containing a space here
  // causes cmd.exe to mis-tokenize the whole invocation — it ends up trying
  // to execute the first half of the path as a bare command
  // ("'D:\redteam\mobile' is not recognized..."), well before the script's
  // own `%*` handling even runs. This reproduced consistently regardless of
  // quoting attempts. The fix: never put the SDK path on the .bat argv at
  // all — pass it only via ANDROID_SDK_ROOT/ANDROID_HOME, which sdkmanager
  // and avdmanager both read directly with no shell re-tokenization
  // involved. Keep every other argument space-free (package ids, flags).
  const sdkEnv = { ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: sdkRoot };
  log.info("Accepting SDK licenses…");
  const sdkm = sdkmanagerPath(sdkRoot, platform);
  await runWithStdin(sdkm, ["--licenses"], "y\n".repeat(20), { env: sdkEnv });

  // 4. Install required SDK packages
  const sysImage = `system-images;android-${cfg.apiLevel};${cfg.systemImageTag};${cfg.abi}`;
  const packages = ["platform-tools", "emulator", sysImage];

  log.info("Installing SDK packages:");
  packages.forEach((p) => log.info(`  ${p}`));

  const code = await runLive(sdkm, ["--install", ...packages], { env: sdkEnv });

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

/**
 * Same check as systemImageInstalled(), but for an arbitrary
 * "system-images;android-<api>;<tag>;<abi>" package id — used by the source
 * AVD, which (unlike the target) is configured via one full package string
 * rather than separate apiLevel/systemImageTag/abi fields on LabConfig.
 * sdkmanager creates on-disk directories matching each package-id segment
 * literally (confirmed: android-37.0's decimal segment is the real
 * directory name, not just android-37), so this is a plain string split,
 * not a re-parse into numeric fields.
 */
export function systemImagePackageInstalled(
  sdkRoot: string,
  imagePackage: string,
): boolean {
  const parts = imagePackage.split(";"); // ["system-images", "android-37.0", "google_apis_playstore", "x86_64"]
  if (parts.length !== 4 || parts[0] !== "system-images") return false;
  const [, apiSegment, tag, abi] = parts;
  return existsSync(
    join(sdkRoot, "system-images", apiSegment, tag, abi, "system.img"),
  );
}

/** Emulator executable path inside the SDK. */
export function emulatorPath(sdkRoot: string, platform: PlatformInfo): string {
  return join(sdkRoot, "emulator", `emulator${platform.exe}`);
}

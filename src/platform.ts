// ── Cross-platform detection (Windows · WSL · Linux · macOS) ─────────────────
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type PlatformType = "windows" | "wsl" | "linux" | "macos";

export interface PlatformInfo {
  /** Canonical platform identifier. */
  type: PlatformType;
  /** ".exe" on windows/wsl, "" everywhere else. */
  exe: string;
  /** True when running inside WSL. */
  isWsl: boolean;
  /** Current user's home directory (Linux path even in WSL). */
  home: string;
  /** Default Android SDK root for this platform. */
  sdkDefaultPath: string;
  /**
   * Windows home mapped into WSL (e.g. /mnt/c/Users/CS5).
   * Only set when isWsl === true and cmd.exe interop is available.
   */
  windowsHome: string | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function detectPlatform(): PlatformInfo {
  if (process.platform === "win32") return buildWindows();
  if (isRunningInWsl()) return buildWsl(resolveWindowsHome());
  if (process.platform === "darwin") return buildMacos();
  return buildLinux();
}

/** Convert a Windows path (C:\Users\name) to a WSL path (/mnt/c/Users/name). */
export function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[/\\]/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, "/");
}

/** Convert a WSL /mnt/... path back to a Windows path (for .exe tools). */
export function toWinPath(unixPath: string): string {
  return unixPath
    .replace(/^\/mnt\/([a-z])\//, (_: string, d: string) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, "\\");
}

// ── Private builders ──────────────────────────────────────────────────────────

function buildWindows(): PlatformInfo {
  const home = homedir();
  return {
    type: "windows",
    exe: ".exe",
    isWsl: false,
    home,
    sdkDefaultPath: join(
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "Android", "Sdk",
    ),
    windowsHome: null,
  };
}

function buildWsl(windowsHome: string | null): PlatformInfo {
  const home = homedir();
  return {
    type: "wsl",
    // Prefer Windows .exe tools (adb.exe, emulator.exe) when available —
    // they talk to the Windows-side emulator without ADB-over-network tricks.
    exe: ".exe",
    isWsl: true,
    home,
    // Without a resolved Windows home (stripped/headless WSL with no
    // cmd.exe interop and an empty/unmounted /mnt/c/Users), there is no
    // reliable Windows-side path to guess — fall back to the Linux-side
    // default rather than fabricating a path like /mnt/c/AppData/... that
    // can never exist. findSdk() in sdk.ts already tries ANDROID_HOME/
    // ANDROID_SDK_ROOT/--sdk-root before this default anyway.
    sdkDefaultPath: windowsHome
      ? join(windowsHome, "AppData", "Local", "Android", "Sdk")
      : join(home, "Android", "Sdk"),
    windowsHome,
  };
}

function buildLinux(): PlatformInfo {
  const home = homedir();
  return {
    type: "linux",
    exe: "",
    isWsl: false,
    home,
    // Android Studio on Linux installs here by default.
    sdkDefaultPath: join(home, "Android", "Sdk"),
    windowsHome: null,
  };
}

function buildMacos(): PlatformInfo {
  const home = homedir();
  return {
    type: "macos",
    exe: "",
    isWsl: false,
    home,
    sdkDefaultPath: join(home, "Library", "Android", "sdk"),
    windowsHome: null,
  };
}

/** True when running inside any WSL distro (WSL1 or WSL2). */
function isRunningInWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Best-effort resolution of the Windows home as a WSL path. Returns null
 * (never a guessed path) when it genuinely can't be determined — the
 * caller falls back to a Linux-side default rather than trusting a path
 * that was never actually confirmed to exist.
 */
function resolveWindowsHome(): string | null {
  // Try to resolve the Windows home via cmd.exe interop.
  try {
    const result = Bun.spawnSync(["cmd.exe", "/c", "echo %USERPROFILE%"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      const raw = result.stdout.toString().trim();
      if (raw && raw !== "%USERPROFILE%") {
        return toWslPath(raw);
      }
    }
  } catch { /* cmd.exe not available — stripped WSL2 */ }

  // Fallback: scan /mnt/c/Users/* for a likely Windows home.
  const usersDir = "/mnt/c/Users";
  if (existsSync(usersDir)) {
    try {
      const entries: string[] = readdirSync(usersDir);
      const candidate = entries.find(e => !["Public", "Default", "All Users"].includes(e));
      if (candidate) return join(usersDir, candidate);
    } catch { /* ignore */ }
  }

  return null;
}

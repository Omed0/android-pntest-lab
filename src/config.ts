// ── Lab configuration — all values with documented defaults ───────────────────
//
// Every value can be overridden three ways (highest-priority first):
//   1. CLI flag:   bun run bootstrap -- --avd-name=MyDevice --avd-ram=8192
//   2. Env var:    LAB_AVD_NAME=MyDevice LAB_AVD_RAM=8192 bun run bootstrap
//   3. Default:    the values below
//
// Role relationships:
//   LAB_TARGET_SERIAL -> rooted device used by bootstrap, run, verify, and Frida
//   LAB_SOURCE_SERIAL -> optional Play Store device used only for APK recovery
//   LAB_SOURCE_AVD -> AVD name started for LAB_SOURCE_SERIAL
//   LAB_BURP_HOST/PORT -> one proxy endpoint written to the target device
//
// PowerShell example for a different machine:
//   $env:LAB_TARGET_SERIAL = "emulator-6000"
//   $env:LAB_SOURCE_SERIAL = "emulator-6002"
//   $env:LAB_SOURCE_AVD = "Play_Source"
//   $env:LAB_BURP_HOST = "192.168.50.20"
//   $env:LAB_BURP_PORT = "8080"
//   bun run e2e -- --package=com.example.authorized --burp-host=$env:LAB_BURP_HOST --burp-port=$env:LAB_BURP_PORT
//
// Examples
// ────────
//   # Minimal — use every default:
//   bun run init
//
//   # Custom AVD name and more RAM:
//   bun run bootstrap -- --avd-name=Pixel_8 --avd-ram=8192
//
//   # Point to a specific SDK root:
//   bun run bootstrap -- --sdk-root="C:\Users\me\AppData\Local\Android\Sdk"
//
//   # Force reinstall of Frida even if already present:
//   bun run bootstrap -- --force-frida
//
//   # Non-default Burp proxy address (e.g. host machine on LAN):
//   bun run.ts --package=com.example.app --burp-host=192.168.1.10 --burp-port=8080
//
//   # Attach to a running emulator without starting a new one:
//   bun run bootstrap -- --skip-emulator
//
// ── Defaults ──────────────────────────────────────────────────────────────────

import { join } from "path";
import { detectPlatform } from "./platform.ts";

export const DEFAULTS = {
  /** Fallback ADB serial; override with LAB_TARGET_SERIAL on each machine. */
  targetSerial:   "emulator-5554",
  /** Fallback source serial; override with LAB_SOURCE_SERIAL. */
  sourceSerial:   "emulator-5556",
  /** Fallback target AVD; override with LAB_AVD_NAME. */
  targetAvdName:  "Pixel_7_Pro",
  /** Fallback source AVD; override with LAB_SOURCE_AVD. */
  sourceAvdName:  "Pixel_10_Pro",
  /** Fallback source image; override with LAB_SOURCE_IMAGE_PACKAGE. */
  sourceImagePackage: "system-images;android-36.1;google_apis_playstore_ps16k;x86_64",
  /**
   * Preferred device profile for the source AVD; override with
   * LAB_SOURCE_DEVICE_PROFILE. This is a *preference*, not a hard
   * requirement — the auto-downloaded "command-line tools only" package
   * ships an older device-definition list than Android Studio does, so
   * newer ids (e.g. a literal "pixel_10_pro") frequently don't exist on a
   * freshly-installed SDK even though they're valid on someone's
   * Studio-managed machine. `resolveDeviceProfile()` in src/avd.ts falls
   * back to the newest available Pixel profile instead of hard-failing
   * when this exact id isn't present.
   */
  sourceDeviceProfile: "pixel_7_pro",

  // ── AVD ──────────────────────────────────────────────────────────────────
  /** Android Virtual Device name shown in Android Studio / avdmanager. */
  avdName:        "Pixel_7_Pro",
  /** Android API level to use.  33 = Android 13. */
  apiLevel:       33,
  /** CPU ABI of the system image.  x86_64 runs fastest on Intel/AMD hosts. */
  abi:            "x86_64",
  /**
   * System-image variant tag.
   * "google_apis"          — Play-Store-free, rootable with rootAVD / Magisk
   * "google_apis_playstore"— includes Play Store (harder to root)
   * "aosp_atd"             — lean automated-test image, fastest boot
   */
  systemImageTag: "google_apis",
  /** Device hardware profile passed to avdmanager -d. */
  deviceProfile:  "pixel_7_pro",
  /** Emulator RAM in MB. */
  avdRamMb:       4096,
  /** Number of vCPU cores inside the emulator. */
  avdCores:       4,
  /** Internal data-partition size in MB. */
  avdDiskMb:      6144,
  /** SD card size in MB (virtual, created automatically). */
  avdSdCardMb:    1024,

  // ── Android SDK ───────────────────────────────────────────────────────────
  /**
   * Android SDK root.  null = auto-detect from:
   *   ANDROID_HOME / ANDROID_SDK_ROOT env vars → platform default path.
   */
  sdkRoot:              null as string | null,
  /**
   * Version string embedded in the Google cmdline-tools download URL.
   * Update this if you need a newer build:
   *   https://developer.android.com/studio#command-line-tools-only
   */
  cmdlineToolsVersion:  "11076708",

  // ── Frida ─────────────────────────────────────────────────────────────────
  /**
   * Frida version to install on the device.
   * "auto" = match whatever `frida --version` reports on the host.
   * Pinning: "17.9.7"
   */
  fridaVersion:   "auto",
  /** Remote directory on the Android device to push frida-server to. */
  fridaRemoteDir: "/data/local/tmp",

  // ── Burp Suite ────────────────────────────────────────────────────────────
  /**
   * IP of the Burp listener as seen from inside the emulator.
   * 10.0.2.2 = the Windows host when using the standard Android emulator NAT.
   * Change to your machine's LAN IP when using a physical device or
   * a non-standard network setup.
   */
  burpHost:       "10.0.2.2",
  burpPort:       8080,

  // ── Runtime ───────────────────────────────────────────────────────────────
  /** How long (seconds) to wait for the emulator to finish booting. */
  emulatorBootTimeoutSec: 300,
} as const;

// ── LabConfig interface ───────────────────────────────────────────────────────

export interface LabConfig {
  targetSerial:   string;
  sourceSerial:   string;
  sourceAvdName:   string;
  sourceImagePackage: string;
  sourceDeviceProfile: string;

  avdName:        string;
  apiLevel:       number;
  abi:            string;
  systemImageTag: string;
  deviceProfile:  string;
  avdRamMb:       number;
  avdCores:       number;
  avdDiskMb:      number;
  avdSdCardMb:    number;

  sdkRoot:              string;   // always resolved, never null after load
  cmdlineToolsVersion:  string;

  fridaVersion:   string;
  fridaRemoteDir: string;

  burpHost: string;
  burpPort: number;

  emulatorBootTimeoutSec: number;

  // Resolved paths (always absolute)
  toolsDir: string;
  cacheDir: string;
  fridaDir: string;

  // Bootstrap flags (CLI-only, no env equivalents)
  installSdk:   boolean;
  forceFrida:   boolean;
  forceAvd:     boolean;
  skipEmulator: boolean;
}

// ── loadConfig ────────────────────────────────────────────────────────────────

/**
 * Build a LabConfig from defaults → env vars → CLI args.
 * @param labRoot   Absolute path to the lab directory (usually import.meta.dir).
 * @param argv      Raw process.argv slice (defaults to process.argv.slice(2)).
 */
export function loadConfig(labRoot: string, argv = process.argv.slice(2)): LabConfig {
  const platform = detectPlatform();
  const args = parseCli(argv);

  if (args["help"] || args["h"]) {
    printHelp();
    process.exit(0);
  }

  function str(key: string, def: string): string {
    return args[key] as string ?? env(key, def);
  }
  function num(key: string, def: number): number {
    const v = args[key] ?? env(key, String(def));
    return Number(v);
  }
  function bool(key: string, def = false): boolean {
    if (key in args) return args[key] !== "false" && args[key] !== false;
    const e = process.env[`LAB_${toEnvKey(key)}`];
    if (e !== undefined) return e !== "0" && e !== "false";
    return def;
  }

  const toolsDir = str("tools-dir", join(labRoot, "tools"));
  const cacheDir = str("cache-dir", join(toolsDir,  "cache"));
  const fridaDir = str("frida-dir", join(toolsDir,  "frida"));

  const sdkRoot =
    str("sdk-root", "") ||
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    platform.sdkDefaultPath;

  return {
    targetSerial:   str("target-serial", DEFAULTS.targetSerial),
    sourceSerial:   str("source-serial", DEFAULTS.sourceSerial),
    sourceAvdName:  str("source-avd", DEFAULTS.sourceAvdName),
    sourceImagePackage: str("source-image-package", DEFAULTS.sourceImagePackage),
    sourceDeviceProfile: str("source-device-profile", DEFAULTS.sourceDeviceProfile),

    avdName:        str("avd-name",         DEFAULTS.avdName),
    apiLevel:       num("api-level",         DEFAULTS.apiLevel),
    abi:            str("abi",               DEFAULTS.abi),
    systemImageTag: str("system-image-tag",  DEFAULTS.systemImageTag),
    deviceProfile:  str("device-profile",    DEFAULTS.deviceProfile),
    avdRamMb:       num("avd-ram",           DEFAULTS.avdRamMb),
    avdCores:       num("avd-cores",         DEFAULTS.avdCores),
    avdDiskMb:      num("avd-disk",          DEFAULTS.avdDiskMb),
    avdSdCardMb:    num("avd-sdcard",        DEFAULTS.avdSdCardMb),

    sdkRoot,
    cmdlineToolsVersion: str("cmdline-tools-version", DEFAULTS.cmdlineToolsVersion),

    fridaVersion:   str("frida-version",   DEFAULTS.fridaVersion),
    fridaRemoteDir: str("frida-remote-dir",DEFAULTS.fridaRemoteDir),

    burpHost: str("burp-host", DEFAULTS.burpHost),
    burpPort: num("burp-port", DEFAULTS.burpPort),

    emulatorBootTimeoutSec: num("boot-timeout", DEFAULTS.emulatorBootTimeoutSec),

    toolsDir,
    cacheDir,
    fridaDir,

    installSdk:   bool("install-sdk"),
    forceFrida:   bool("force-frida"),
    forceAvd:     bool("force-avd"),
    skipEmulator: bool("skip-emulator"),
  };
}

// ── CLI parser ────────────────────────────────────────────────────────────────
// Supports:  --key=value   --key value   --flag   --no-flag

function parseCli(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const stripped = a.slice(2);
    const eq = stripped.indexOf("=");
    if (eq !== -1) {
      out[stripped.slice(0, eq)] = stripped.slice(eq + 1);
    } else if (stripped.startsWith("no-")) {
      out[stripped.slice(3)] = false;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[stripped] = argv[++i];
    } else {
      out[stripped] = true;
    }
  }
  return out;
}

function env(key: string, fallback: string): string {
  return process.env[`LAB_${toEnvKey(key)}`] ?? fallback;
}

function toEnvKey(key: string): string {
  return key.toUpperCase().replace(/-/g, "_");
}

// ── Help text ─────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Android Pentest Lab — Bun/TypeScript cross-platform bootstrap
  Works on: Windows 11 · WSL2 · Linux

Usage
  bun run bootstrap -- [options] # set up the rooted lab
  bun run.ts       [options]     # attach Frida to a target app
  bun verify.ts                  # quick connectivity check

AVD options (default → env var → flag)
  --target-serial=<id>      Rooted lab ADB serial [LAB_TARGET_SERIAL]
  --source-serial=<id>      Play Store source serial [LAB_SOURCE_SERIAL]
  --source-avd=<name>       Play Store source AVD [LAB_SOURCE_AVD]
  --source-image-package=<p> Source image package [LAB_SOURCE_IMAGE_PACKAGE]
  --avd-name=<name>        AVD name          [${DEFAULTS.avdName}]  LAB_AVD_NAME
  --api-level=<n>          Android API level [${DEFAULTS.apiLevel}]      LAB_API_LEVEL
  --abi=<abi>              CPU ABI           [${DEFAULTS.abi}]   LAB_ABI
  --system-image-tag=<t>   System image tag  [${DEFAULTS.systemImageTag}]  LAB_SYSTEM_IMAGE_TAG
  --device-profile=<p>     Device profile    [${DEFAULTS.deviceProfile}]   LAB_DEVICE_PROFILE
  --avd-ram=<MB>           RAM in MB         [${DEFAULTS.avdRamMb}]       LAB_AVD_RAM
  --avd-cores=<n>          vCPU cores        [${DEFAULTS.avdCores}]           LAB_AVD_CORES
  --avd-disk=<MB>          Data partition MB [${DEFAULTS.avdDiskMb}]       LAB_AVD_DISK
  --avd-sdcard=<MB>        SD card MB        [${DEFAULTS.avdSdCardMb}]       LAB_AVD_SDCARD

SDK options
  --sdk-root=<path>        Android SDK root  [auto-detect]     LAB_SDK_ROOT
  --install-sdk            Download+install cmdline-tools if SDK not found
  --cmdline-tools-version  SDK build number  [${DEFAULTS.cmdlineToolsVersion}]

Frida options
  --frida-version=<ver>    Pin frida version ["auto" = match host]  LAB_FRIDA_VERSION
  --frida-remote-dir=<p>   Remote path       [${DEFAULTS.fridaRemoteDir}]
  --force-frida            Re-push frida-server even if already running

Burp options
  --burp-host=<ip>         Proxy host        [${DEFAULTS.burpHost}]  LAB_BURP_HOST
  --burp-port=<n>          Proxy port        [${DEFAULTS.burpPort}]        LAB_BURP_PORT

Runtime flags
  --skip-emulator          Skip starting the emulator (already running)
  --force-avd              Recreate AVD even if it already exists
  --boot-timeout=<sec>     Boot wait timeout [${DEFAULTS.emulatorBootTimeoutSec}s]

run.ts extra options
  --package=<pkg>          App package name  (required)
  --apk=<path>             APK to install before attaching
  --main-activity=<cls>    Activity to launch (optional)
  --frida-script=<path>    Frida JS script   [scripts/hook.js]
  --no-burp                Skip Burp proxy setup
`);
}

/** Pretty-print the active config for diagnostics. */
export function printConfig(cfg: LabConfig): void {
  console.log("  Target: ", cfg.targetSerial);
  console.log("  AVD:    ", cfg.avdName,
    `  android-${cfg.apiLevel}  ${cfg.systemImageTag}/${cfg.abi}`);
  console.log("  RAM:    ", cfg.avdRamMb, "MB  cores:", cfg.avdCores);
  console.log("  SDK:    ", cfg.sdkRoot);
  console.log("  Frida:  ", cfg.fridaVersion === "auto" ? "auto (match host)" : cfg.fridaVersion);
  console.log("  Burp:   ", `${cfg.burpHost}:${cfg.burpPort}`);
}

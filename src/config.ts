// ── Lab configuration — all values with documented defaults ───────────────────
//
// Every value can be overridden three ways (highest-priority first):
//   1. CLI flag:   bun run init -- --avd-name=MyDevice --avd-ram=8192
//   2. Env var:    LAB_AVD_NAME=MyDevice LAB_AVD_RAM=8192 bun run init
//   3. Default:    the values below
//
// Role relationships:
//   LAB_TARGET_SERIAL -> rooted device used by init, run, verify, and Frida
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
//   bun run init -- --install-sdk
//   bun run run -- --package=com.example.authorized --burp-host=$env:LAB_BURP_HOST --burp-port=$env:LAB_BURP_PORT
//
// Examples
// ────────
//   # Minimal — use every default:
//   bun run init -- --install-sdk
//
//   # Custom AVD name and more RAM:
//   bun run init -- --avd-name=Pixel_8 --avd-ram=8192
//
//   # Point to a specific SDK root:
//   bun run init -- --sdk-root="C:\Users\me\AppData\Local\Android\Sdk"
//
//   # Force reinstall of Frida even if already present:
//   bun run init -- --force-frida
//
//   # Non-default Burp proxy address (e.g. host machine on LAN):
//   bun run run -- --package=com.example.app --burp-host=192.168.1.10 --burp-port=8080
//
//   # Attach to a running emulator without starting a new one:
//   bun run init -- --skip-emulator
//
//   # Delete this lab's AVDs + downloaded tools before a from-scratch rebuild:
//   bun run clean
//
// ── Defaults ──────────────────────────────────────────────────────────────────

import { join } from "path";
import { detectPlatform } from "./platform.ts";

export const DEFAULTS = {
  /** Fallback ADB serial; override with LAB_TARGET_SERIAL on each machine. */
  targetSerial:   "emulator-5554",
  /** Fallback source serial; override with LAB_SOURCE_SERIAL. */
  sourceSerial:   "emulator-5556",
  /** Fallback source AVD; override with LAB_SOURCE_AVD. */
  sourceAvdName:  "Pixel_10_Pro",
  /**
   * Fallback source image; override with LAB_SOURCE_IMAGE_PACKAGE.
   *
   * Deliberately NOT a "_ps16k" (16 KB Page Size) variant — that's an
   * explicitly-labeled "Pre-Release" experimental system image, and is very
   * likely the actual cause of most of the source-emulator instability seen
   * this session (DMA-readback assertion crashes on `screencap`, Windows
   * "device attached to the system is not functioning" GDI layered-window
   * failures, and boot timeouts under `-gpu auto` even with GPU enabled) —
   * none of that is expected from a normal, non-experimental Play Store
   * image. android-37.0's plain `google_apis_playstore` (no ps16k suffix)
   * is the newest STABLE Play Store image available as of this writing.
   */
  sourceImagePackage: "system-images;android-37.0;google_apis_playstore;x86_64",
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

  // ── Proxy (Burp Suite by default, any other tool also works) ───────────────
  /**
   * IP of the proxy listener as seen from inside the emulator.
   * 10.0.2.2 = the Windows host when using the standard Android emulator NAT.
   * Change to your machine's LAN IP when using a physical device or
   * a non-standard network setup.
   *
   * Burp Suite is the default and needs no extra flags. To use a different
   * proxy tool, override --proxy-host/--proxy-port (same effect as the older
   * --burp-host/--burp-port names, kept working as aliases) and either drop
   * that tool's CA certificate under cert/ or pass --proxy-cert=<path>. To
   * use no proxy at all, pass --no-proxy (alias: --no-burp).
   */
  burpHost:       "10.0.2.2",
  burpPort:       8080,
  /**
   * When true (default), every `bun run init` also sets the target's global
   * HTTP/HTTPS proxy to burpHost:burpPort and installs the proxy's CA into
   * the system trust store — so the lab is proxy-ready as soon as init
   * finishes, without waiting for the first `bun run.ts` (which re-applies
   * the same idempotent steps anyway, e.g. after a device restart). Disable
   * with --no-proxy if you don't want any proxy touched during init.
   */
  proxyEnabled:   true,
  /**
   * "burp" auto-downloads the CA from Burp's built-in http://burp/cert
   * endpoint through the configured proxy. "other" skips that (a non-Burp
   * tool won't answer there) and expects a CA file under cert/ or
   * --proxy-cert=<path> instead.
   */
  proxyTool:      "burp" as "burp" | "other",

  // ── Runtime ───────────────────────────────────────────────────────────────
  /** How long (seconds) to wait for the emulator to finish booting. */
  emulatorBootTimeoutSec: 300,
  /**
   * TARGET emulator `-gpu` mode. "auto" lets the emulator pick the best
   * available backend (host GPU when usable). The earlier "black/white/grey
   * screen" was NOT actually a `-gpu` mode problem — the real cause was the
   * AVD's config.ini having hw.gpu.enabled=no (headless `avdmanager create`
   * default), which forces a broken guest software renderer regardless of
   * this flag. That's fixed in applyGpuConfig() (src/avd.ts), which now
   * writes hw.gpu.enabled=yes + hw.gpu.mode=auto like Android Studio does;
   * with GPU actually enabled, "auto" renders correctly on the host GPU.
   * Override with --gpu-mode=<mode> ("host", "swiftshader_indirect", etc.)
   * if a specific machine needs it. A one-shot boot-timeout fallback to
   * swiftshader still exists in src/lab.ts for genuinely GPU-less hosts.
   */
  gpuMode:        "auto",
  /**
   * SOURCE (Play Store) emulator retry-only `-gpu` mode. NOT passed on the
   * source's normal launch — confirmed directly that launching the source
   * AVD exactly like Android Studio's own Device Manager does (no explicit
   * `-gpu` CLI override at all, letting hw.gpu.mode=auto from config.ini be
   * the only GPU setting in effect) renders correctly, while this project's
   * own earlier custom `-gpu auto` CLI override on the same AVD produced
   * real instability (DMA-readback assertion crashes on `screencap`,
   * Windows "device attached to the system is not functioning" GDI
   * layered-window failures, and boot timeouts). This value is used ONLY as
   * a one-shot forced override if the source's normal (flagless) launch
   * times out — see initializeLab() in src/lab.ts.
   */
  sourceGpuMode:  "swiftshader_indirect",

  // ── Emulator window ──────────────────────────────────────────────────────
  /**
   * Show the emulator window normally (not hidden) so first-run interaction
   * (Play Store sign-in, manually using an app to generate traffic) doesn't
   * require hunting for a hidden window.
   */
  showWindow:     true,
  /**
   * Pin the emulator window to a fixed position/size and lock the AVD's own
   * emulator-user.ini read-only, so the emulator can't overwrite it with
   * whatever position/size it was last closed at (it rewrites this file on
   * every clean shutdown otherwise). Applied once right after the AVD is
   * created/found, not on every launch. Applied to the TARGET only — the
   * source AVD is deliberately left unlocked/unsized (see sourceGpuMode's
   * comment above: matching Android Studio's own flagless launch is what
   * actually renders correctly for the source).
   */
  lockWindow:     true,
  windowX:        0,
  windowY:        0,
  /**
   * Window scale. 0 (default) = auto-fit: lockEmulatorWindow() (src/avd.ts)
   * computes the largest scale that fits the device's full height within
   * ~92% of THIS machine's actual screen work area — a fixed guess like 0.3
   * is wrong on a small/remote display (confirmed: 0.3 already overflowed a
   * 1280x752 work area here) and leaves free space unused on a large one.
   * Pass an explicit --window-scale=<n> (0 < n <= 1.0; 1.0 = native size) to
   * override with a literal scale instead.
   */
  windowScale:    0,

  // ── Portable mode ─────────────────────────────────────────────────────────
  /**
   * When true, Java/Python/7-Zip are downloaded as portable/zip
   * distributions into this lab's own tools/ directory and used only from
   * there — never a system-wide winget install, and never a silent fallback
   * to a copy that happens to already be on the host's PATH. The Android
   * SDK/AVD are already self-contained under --sdk-root/ANDROID_AVD_HOME
   * regardless of this flag. Use this to verify (or run) the lab without
   * touching anything outside its own directory tree.
   */
  portable:       false,

  // ── Android Studio (optional GUI) ────────────────────────────────────────
  /**
   * When true and --install-sdk is passed, also installs Android Studio for
   * real via `winget install --id Google.AndroidStudio` — a normal, visible
   * Start Menu / Windows Search install, deliberately the OPPOSITE of the
   * hidden `portable` pattern above. Purely additive: the CLI-managed
   * SDK/AVDs this lab actually drives are unaffected either way. Skip with
   * --no-android-studio.
   */
  androidStudio:  true,

  // ── Root ──────────────────────────────────────────────────────────────────
  /**
   * When true, after the target boots, download rootAVD
   * (https://github.com/newbit1/rootAVD) and patch the target's ramdisk
   * with real Magisk (not just `adb root`) — some apps detect root via the
   * `su`/Magisk app specifically, not the adbd root mode this lab already
   * uses by default. Off by default because it modifies the AVD image and
   * takes an extra boot cycle; pass --magisk-root to enable it. See
   * src/magisk.ts (ensureMagiskRoot) for the implementation.
   */
  magiskRoot:     false,
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
  proxyEnabled: boolean;
  proxyTool: "burp" | "other";

  emulatorBootTimeoutSec: number;
  gpuMode: string;
  sourceGpuMode: string;
  showWindow: boolean;
  lockWindow: boolean;
  windowX: number;
  windowY: number;
  windowScale: number;

  // Resolved paths (always absolute)
  toolsDir: string;
  cacheDir: string;
  fridaDir: string;

  // Bootstrap flags (CLI-only, no env equivalents)
  installSdk:   boolean;
  forceFrida:   boolean;
  forceAvd:     boolean;
  skipEmulator: boolean;
  portable:     boolean;
  androidStudio: boolean;
  magiskRoot:   boolean;
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
  /** Like str(), but tries several CLI/env key spellings in priority order (aliases). */
  function strAlias(keys: string[], def: string): string {
    for (const key of keys) if (key in args) return args[key] as string;
    for (const key of keys) {
      const e = process.env[`LAB_${toEnvKey(key)}`];
      if (e !== undefined) return e;
    }
    return def;
  }
  function numAlias(keys: string[], def: number): number {
    return Number(strAlias(keys, String(def)));
  }

  const toolsDir = str("tools-dir", join(labRoot, "tools"));
  const cacheDir = str("cache-dir", join(toolsDir,  "cache"));
  const fridaDir = str("frida-dir", join(toolsDir,  "frida"));
  const portable = bool("portable");

  // In --portable mode, don't silently pick up a real Android SDK the host
  // already has (via ANDROID_HOME/ANDROID_SDK_ROOT or the platform default
  // path) — default to a private copy under this project's own tools/
  // instead, same as every other portable-mode dependency. An explicit
  // --sdk-root still wins either way.
  const sdkRoot =
    str("sdk-root", "") ||
    (portable
      ? join(toolsDir, "android-sdk")
      : process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || platform.sdkDefaultPath);

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

    burpHost: strAlias(["proxy-host", "burp-host"], DEFAULTS.burpHost),
    burpPort: numAlias(["proxy-port", "burp-port"], DEFAULTS.burpPort),
    proxyEnabled: bool("proxy", DEFAULTS.proxyEnabled) && bool("burp", DEFAULTS.proxyEnabled),
    proxyTool: (strAlias(["proxy-tool"], DEFAULTS.proxyTool) === "other" ? "other" : "burp"),

    emulatorBootTimeoutSec: num("boot-timeout", DEFAULTS.emulatorBootTimeoutSec),
    gpuMode: str("gpu-mode", DEFAULTS.gpuMode),
    sourceGpuMode: str("source-gpu-mode", DEFAULTS.sourceGpuMode),
    showWindow: bool("show-window", DEFAULTS.showWindow),
    lockWindow: bool("lock-window", DEFAULTS.lockWindow),
    windowX: num("window-x", DEFAULTS.windowX),
    windowY: num("window-y", DEFAULTS.windowY),
    windowScale: num("window-scale", DEFAULTS.windowScale),

    toolsDir,
    cacheDir,
    fridaDir,

    installSdk:   bool("install-sdk"),
    forceFrida:   bool("force-frida"),
    forceAvd:     bool("force-avd"),
    skipEmulator: bool("skip-emulator"),
    portable,
    androidStudio: bool("android-studio", DEFAULTS.androidStudio),
    magiskRoot:    bool("magisk-root", DEFAULTS.magiskRoot),
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
Android Pentest Lab — Bun/TypeScript automation
  Primary target: Windows 11

Usage
  bun run init -- [options]      # set up the rooted lab (AVD, SDK, Frida)
  bun run run  -- [options]      # attach Frida to a target app
  bun run clean                  # delete this lab's AVDs + downloaded tools
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
  --no-android-studio      With --install-sdk, skip installing the Android
                           Studio GUI (winget). On by default; purely
                           additive to the CLI-managed SDK this lab uses.

Root options
  --magisk-root            Patch the target's ramdisk with real Magisk via
                           rootAVD after first boot (su/Magisk-specific
                           detection, not just adb-root). Off by default.

Frida options
  --frida-version=<ver>    Pin frida version ["auto" = match host]  LAB_FRIDA_VERSION
  --frida-remote-dir=<p>   Remote path       [${DEFAULTS.fridaRemoteDir}]
  --force-frida            Re-push frida-server even if already running

Proxy options (Burp Suite by default — any other proxy tool also works)
  --proxy-host=<ip>        Proxy host        [${DEFAULTS.burpHost}]  LAB_PROXY_HOST
  --proxy-port=<n>         Proxy port        [${DEFAULTS.burpPort}]        LAB_PROXY_PORT
  --burp-host / --burp-port   Older names, still work as aliases for the above.
  --proxy-tool=<burp|other> Whether to auto-fetch the CA from http://burp/cert [${DEFAULTS.proxyTool}]
                           "other" skips that and expects a CA under cert/ or --proxy-cert=<path>.
  --no-proxy               Skip setting the device proxy + installing the CA
                           during "bun run init" entirely (alias: --no-burp).
                           "bun run run" still does its own proxy setup
                           unless it's also passed --no-proxy there.

Runtime flags
  --skip-emulator          Skip starting the emulator (already running)
  --force-avd              Recreate AVD even if it already exists
  --boot-timeout=<sec>     Boot wait timeout [${DEFAULTS.emulatorBootTimeoutSec}s]
  --gpu-mode=<mode>        Target emulator -gpu mode [${DEFAULTS.gpuMode}]  LAB_GPU_MODE
                           Host GPU when usable; hw.gpu.enabled=yes is
                           written to the AVD's config.ini so this works.
  --source-gpu-mode=<mode> Source emulator retry-only -gpu mode
                           [${DEFAULTS.sourceGpuMode}]  LAB_SOURCE_GPU_MODE
                           Not used on the source's normal launch (matches
                           Android Studio's own flagless Device Manager
                           launch) — only forced if that launch times out.
  --no-show-window         Launch the emulator hidden instead of visible
  --no-lock-window         Don't pin/lock the emulator window position+size
  --window-x=<px>          Emulator window X position    [${DEFAULTS.windowX}]  LAB_WINDOW_X
  --window-y=<px>          Emulator window Y position    [${DEFAULTS.windowY}]  LAB_WINDOW_Y
  --window-scale=<0-1>     Emulator window scale         [${DEFAULTS.windowScale}]  LAB_WINDOW_SCALE
  --portable               Download Java/Python/7-Zip into tools/ only — never
                           touches the host's own installs or uses winget.

run.ts extra options
  --package=<pkg>          App package name  (required)
  --apk=<path>             APK to install before attaching
  --main-activity=<cls>    Activity to launch (optional)
  --frida-script=<path>    Frida JS script   [scripts/hook.js]
  --proxy-tool=<burp|other> Whether to attempt Burp's auto CA download [burp]
  --proxy-cert=<path>      Proxy CA certificate (default: first cert in ./cert)
  --no-proxy               Skip proxy setup entirely (alias: --no-burp)
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
  console.log("  Proxy:  ", `${cfg.burpHost}:${cfg.burpPort}`, "(Burp by default)");
  console.log("  GPU:    ", cfg.gpuMode, cfg.portable ? " · portable mode" : "");
}

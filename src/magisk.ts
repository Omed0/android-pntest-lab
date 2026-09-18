// ── Magisk root (rootAVD) — opt-in, real Magisk on top of adb-root ────────────
//
// adb.verifyRoot() (src/adb.ts) already gets full root on this lab's default
// userdebug system image via a plain `adb root` — no Magisk needed for this
// lab's own purposes (frida-server, cert installation both work fine with
// just adbd-as-root). But some apps under test specifically fingerprint root
// via the `su` binary or the Magisk app package itself, rather than checking
// `uid=0` in the shell — `adb root` alone does not fool that class of check.
//
// This module layers REAL Magisk on top via rootAVD
// (https://github.com/newbit1/rootAVD, archived but the last release is
// still the working reference) for users who explicitly opt in with
// --magisk-root. It's a heavier, slower, and riskier operation (it patches
// the AVD's ramdisk image and requires a full emulator restart) than
// everything else this project does automatically, so every code path here
// is a strict no-op unless cfg.magiskRoot is true.
//
// Everything below reflects rootAVD's ACTUAL behavior, confirmed by
// downloading its repo and reading rootAVD.bat/rootAVD.sh directly (not
// assumed from its README alone) — see the comments at each step for what
// was verified and why it matters.

import { existsSync } from "fs";
import { dirname, join, relative } from "path";
import { log } from "./log.ts";
import { runWithStdin } from "./exec.ts";
import { downloadFile, extractZipFlattenRoot } from "./download.ts";
import { killEmulator, startEmulator } from "./avd.ts";
import type { LabConfig } from "./config.ts";
import type { PlatformInfo } from "./platform.ts";
import type { Adb } from "./adb.ts";

const ROOTAVD_ZIP_URL = "https://github.com/newbit1/rootAVD/archive/refs/heads/master.zip";

/**
 * Download + extract rootAVD's toolkit into cfg.toolsDir/rootavd/ (idempotent
 * — a no-op if rootAVD.bat is already there). Returns the absolute path to
 * rootAVD.bat.
 *
 * rootAVD's GitHub repo ships its own bundled `Magisk.zip` alongside
 * rootAVD.bat/rootAVD.sh — confirmed directly by downloading it. rootAVD.bat
 * pushes that Magisk.zip to the device itself as part of patching, and (per
 * the on-device menu logic in rootAVD.sh, see ensureMagiskRoot() below) the
 * default, no-input selection installs exactly that bundled build. There is
 * no need to separately fetch a Magisk APK from topjohnwu/Magisk's own
 * GitHub releases — the task brief speculated this might be necessary, but
 * it isn't; rootAVD is fully self-contained once its own zip is extracted.
 *
 * Deviation from the originally sketched signature `(cfg) => Promise<string>`:
 * a `platform` parameter is required here (not just `cfg`) because the
 * shared extractZipFlattenRoot()/downloadFile() helpers this reuses need it
 * for their own Windows-vs-POSIX extraction logic — there was no way to
 * avoid it without reimplementing extraction.
 */
export async function ensureRootAVDToolkit(cfg: LabConfig, platform: PlatformInfo): Promise<string> {
  const destDir = join(cfg.toolsDir, "rootavd");
  const batPath = join(destDir, "rootAVD.bat");

  if (existsSync(batPath)) {
    log.good(`rootAVD toolkit already present: ${destDir}`);
    return batPath;
  }

  log.info("Downloading rootAVD toolkit (Magisk ramdisk patcher)…");
  const zipFile = join(cfg.cacheDir, "rootAVD-master.zip");
  await downloadFile(ROOTAVD_ZIP_URL, zipFile);
  // GitHub's branch-archive zip wraps everything in a single "rootAVD-master/"
  // folder — extractZipFlattenRoot() strips that so rootAVD.bat lands
  // directly at destDir/rootAVD.bat regardless of the archive's internal
  // folder name (same technique already used for the portable JRE in
  // src/sdk.ts).
  extractZipFlattenRoot(zipFile, destDir, platform, cfg);

  if (!existsSync(batPath)) {
    throw new Error(`rootAVD toolkit download did not produce rootAVD.bat at expected path: ${batPath}`);
  }
  log.good(`rootAVD toolkit ready: ${destDir}`);
  return batPath;
}

/**
 * Resolve the ramdisk.img path for the currently-configured target AVD's
 * system image, e.g.
 *   <sdkRoot>/system-images/android-33/google_apis/x86_64/ramdisk.img
 * Throws a clear, actionable error if the system image (and therefore this
 * file) isn't installed yet.
 */
export function findRamdiskImage(cfg: LabConfig): string {
  const ramdiskPath = join(
    cfg.sdkRoot,
    "system-images",
    `android-${cfg.apiLevel}`,
    cfg.systemImageTag,
    cfg.abi,
    "ramdisk.img",
  );
  if (!existsSync(ramdiskPath)) {
    throw new Error(
      `ramdisk.img not found for android-${cfg.apiLevel} ${cfg.systemImageTag}/${cfg.abi}: ${ramdiskPath}\n` +
      "The target system image isn't installed yet. Rerun with --install-sdk first, then retry --magisk-root.",
    );
  }
  return ramdiskPath;
}

/**
 * Best-effort check for "Magisk is already installed on this device" so
 * re-running `bun run init` with --magisk-root repeatedly doesn't re-patch
 * the ramdisk every time. Two independent signals, since neither is
 * universally reliable on its own (a hidden/repackaged Magisk app won't show
 * up under its default package name; a very old Magisk build might not lay
 * files out under /data/adb/magisk exactly):
 *   - the stock Magisk app package is installed (com.topjohnwu.magisk)
 *   - /data/adb/magisk exists (Magisk's own on-device install directory)
 */
function alreadyMagiskRooted(adb: Adb): boolean {
  const pkg = adb.shell("pm list packages com.topjohnwu.magisk");
  if (pkg.includes("com.topjohnwu.magisk")) return true;

  const magiskDir = adb.rootShell("test -d /data/adb/magisk && echo YES || true").trim();
  return magiskDir === "YES";
}

/**
 * Patch the target AVD's ramdisk with Magisk via rootAVD, so `su` and the
 * Magisk app package become real, on-device artifacts — not just an
 * adb-rooted shell — for apps that specifically fingerprint those.
 *
 * PRECONDITION (caller's responsibility, see src/lab.ts bootstrapLab()): the
 * target AVD must already be running and adb-reachable when this is called.
 * rootAVD.bat pushes/patches over a live adb connection; it does not work
 * against a stopped emulator. This is called right after adb.verifyRoot()
 * succeeds, which guarantees both "adb reaches the device" and "we already
 * have adb-root," which rootAVD's own push/pull steps also rely on.
 *
 * No-op (does nothing at all) unless cfg.magiskRoot is true — this is a
 * strict opt-in, never run by default. Never throws out of this function:
 * on failure it logs a clear warning and returns, so the rest of
 * bootstrapLab() (Frida deployment etc., which only need the adb-root access
 * already confirmed by verifyRoot()) keeps working regardless.
 */
export async function ensureMagiskRoot(cfg: LabConfig, platform: PlatformInfo, adb: Adb): Promise<void> {
  if (!cfg.magiskRoot) return;

  // rootAVD's own compatibility notes call out API 28 as unsupported; fail
  // fast with a clear message instead of letting the patch run and silently
  // produce a broken/unbootable ramdisk.
  if (cfg.apiLevel === 28) {
    log.warn("--magisk-root requested but Android API 28 is explicitly unsupported by rootAVD — skipping. Use a different --api-level (33 is this project's default and is supported).");
    return;
  }

  log.step("Magisk root (rootAVD)");

  if (alreadyMagiskRooted(adb)) {
    log.good("Device is already Magisk-rooted (Magisk app/on-device dir found) — skipping rootAVD patch.");
    return;
  }

  try {
    const batPath = await ensureRootAVDToolkit(cfg, platform);
    const rootAvdDir = dirname(batPath);
    const ramdiskAbs = findRamdiskImage(cfg);

    // rootAVD.bat resolves its target file by literally concatenating its
    // ANDROID_HOME env var with argv[1] (`set AVDPATHWITHRDFFILE=%ANDROIDHOME%%1`
    // — confirmed by reading rootAVD.bat's source directly, and reproduced
    // empirically: an ABSOLUTE ramdisk path here silently breaks, becoming
    // "<sdkRoot>\<absolute-path>", which never exists, causing rootAVD to
    // fall through to its help text and exit 0 having done nothing). This
    // contradicts rootAVD's own top-of-file usage comment, which implies an
    // absolute path is fine — it isn't. The only form that actually works is
    // a path RELATIVE to whatever ANDROID_HOME is set to for this
    // invocation, so ANDROID_HOME is pinned to cfg.sdkRoot below and the
    // ramdisk path passed on argv is relative to it.
    const ramdiskRel = relative(cfg.sdkRoot, ramdiskAbs);

    log.warn(
      "Patching the AVD's ramdisk with Magisk via rootAVD. This assumes the AVD is " +
      "already running and adb-reachable (guaranteed by bootstrapLab() calling this " +
      "right after adb.verifyRoot() succeeds).",
    );

    // rootAVD.sh (the on-device half — rootAVD.bat pushes it and runs it via
    // `adb shell sh <path> <args>`) shows an interactive menu of Magisk
    // builds (Stable / Canary / Alpha / its own bundled "local" copy) ONLY
    // when the AVD has outbound network access to fetch the release JSON for
    // each channel; confirmed directly in rootAVD.sh's CheckAvailableMagisks()
    // / FetchMagiskDLData(): a bare ENTER keypress (`read -t 10 choice` with
    // empty input defaulting to choice=1) always selects menu entry [1],
    // which FetchMagiskDLData() always places first — the toolkit's bundled
    // "local" Magisk.zip pushed alongside rootAVD.sh itself. That's
    // deterministic and reproducible across runs (unlike "latest stable",
    // which drifts over time and depends on GitHub being reachable from
    // inside the emulator). If the AVD has no network access at all, the
    // menu is skipped entirely and the same local build is used
    // automatically — so feeding a bare newline is correct and safe either
    // way.
    const result = await runWithStdin(
      batPath,
      [ramdiskRel],
      "\n",
      {
        // rootAVD.bat captures its own working directory as ROOTAVD
        // (`set ROOTAVD=%cd%`) and resolves Magisk.zip/rootAVD.sh/Apps/
        // relative to THAT, not to the script file's own location —
        // confirmed by reading the source. cwd must therefore be the
        // extracted toolkit directory itself.
        cwd: rootAvdDir,
        env: { ANDROID_HOME: cfg.sdkRoot, ANDROID_SDK_ROOT: cfg.sdkRoot },
      },
    );

    if (!result.ok) {
      log.warn(`rootAVD did not exit cleanly (exit ${result.exitCode}) — Magisk root may not have been fully applied.`);
      if (result.stderr.trim()) log.warn(result.stderr.trim().slice(0, 800));
    }

    // rootAVD.bat's own final step (:ShutDownAVD) only runs
    // `adb shell setprop sys.powerctl shutdown` — confirmed directly in its
    // source, along with its own printed line "Shut-Down and Reboot [Cold
    // Boot Now] the AVD and see IF it worked." It deliberately powers the
    // AVD off and stops there; it does NOT relaunch it. A plain `adb reboot`
    // would not be enough even if we issued it ourselves: the patched
    // ramdisk lives in the AVD's own image files on disk and is only read
    // when the emulator (qemu) process itself does a fresh cold boot, not
    // when Android restarts inside an already-running qemu process. So this
    // does a full kill + relaunch, mirroring the retry path in
    // src/lab.ts bootstrapLab().
    log.info("Waiting for the AVD to power off after patching…");
    for (let i = 0; i < 20 && adb.getEmulator(); i++) Bun.sleepSync(1_000);
    killEmulator(adb.exePath, cfg.targetSerial); // best-effort — in case poweroff didn't fully exit the process
    Bun.sleepSync(2_000);

    log.info("Cold-booting the AVD to apply the Magisk-patched ramdisk…");
    await startEmulator(cfg, platform);
    adb.waitForBoot(cfg.emulatorBootTimeoutSec);

    // Verify uid=0 is reachable via `su` SPECIFICALLY (not just adb-root,
    // which was already true before this ever ran) — this is the actual
    // point of the whole feature. Call adb.shell() directly here rather than
    // adb.rootShell(): rootShell() caches "adbroot" mode from the earlier
    // verifyRoot() call and would just run the command plain, never
    // exercising the su binary this is meant to confirm.
    const suCheck = adb.shell("su -c id");
    if (!/uid=0/.test(suCheck)) {
      // Two genuinely different failure shapes, confirmed by direct testing
      // against a real google_apis_playstore target:
      //   - suCheck is EMPTY: the ramdisk patch or Magisk app install itself
      //     failed — see the rootAVD output above / retry guidance below.
      //   - suCheck is "Permission denied": the patch and daemon are BOTH
      //     fine (confirmed via `ps -A | grep magiskd` showing it running as
      //     root, and `pm list packages` showing com.topjohnwu.magisk
      //     installed) — Magisk's own su ACCESS POLICY is just denying this
      //     specific request because there's no human available to approve
      //     the grant prompt for a headless `adb shell su` call. This is a
      //     one-time manual step, not a retry-the-patch problem: open the
      //     Magisk app inside the emulator (visible in its window) and set
      //     Superuser access so ADB/shell requests are auto-granted instead
      //     of prompted. `bun run init --magisk-root` will pick it up on
      //     the very next run without repatching anything.
      const deniedByPolicy = /permission denied/i.test(suCheck);
      throw new Error(
        deniedByPolicy
          ? "Magisk patch and daemon are both fine, but 'su -c id' got \"Permission denied\" — " +
            "this is Magisk's OWN su access policy denying a headless request with no human " +
            "to approve the grant prompt, not a broken patch.\n" +
            "Fix (one-time, per AVD): open the Magisk app inside the emulator window and set " +
            "Superuser access to auto-grant (not prompt) for ADB/shell requests, then rerun " +
            "`bun run init --magisk-root` — it will pick up the change immediately, no repatch needed."
          : `Magisk patch ran but 'su -c id' did not report uid=0 (got: "${suCheck}").\n` +
            "The ramdisk patch or the Magisk app install likely failed silently. Re-check the\n" +
            "rootAVD output above, or force a clean retry by deleting the toolkit directory:\n" +
            `  ${rootAvdDir}\n` +
            "and rerunning with --magisk-root.",
      );
    }
    log.good("Magisk root verified via `su -c id` (uid=0).");
  } catch (error) {
    // This is an opt-in, higher-risk extra layered on top of the adb-root
    // access every other bootstrap step depends on, which is already
    // confirmed working by the time this runs (verifyRoot() succeeded
    // before ensureMagiskRoot() was ever called). A failure here must never
    // abort the rest of bootstrapLab() — warn clearly and let Frida
    // deployment etc. proceed on adb-root alone.
    log.warn(`Magisk root setup failed: ${error instanceof Error ? error.message : String(error)}`);
    log.warn("Continuing without Magisk — adb-root access (frida-server, cert install) is unaffected.");
  }
}

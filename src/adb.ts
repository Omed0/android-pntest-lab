// ── ADB wrapper ───────────────────────────────────────────────────────────────
import { existsSync } from "fs";
import { join } from "path";
import { run } from "./exec.ts";
import { log } from "./log.ts";
import { toWinPath } from "./platform.ts";
import type { PlatformInfo } from "./platform.ts";

export class Adb {
  private rootMode: "adbroot" | "su" | null = null;

  constructor(
    public readonly exePath: string,
    public readonly serial?: string,
  ) {}

  // ── Internal ───────────────────────────────────────────────────────────────

  private exec(...args: string[]) {
    return run(this.exePath, this.serial ? ["-s", this.serial, ...args] : args);
  }

  // ── Server ────────────────────────────────────────────────────────────────

  startServer(): void {
    run(this.exePath, ["start-server"]);
  }

  killServer(): void {
    run(this.exePath, ["kill-server"]);
  }

  // ── Device listing ────────────────────────────────────────────────────────

  /** Raw device lines from `adb devices` (excluding the header). */
  devices(): string[] {
    const r = run(this.exePath, ["devices"]);
    return r.stdout
      .split(/\r?\n/)
      .slice(1)
      .map(l => l.trim())
      .filter(Boolean);
  }

  /** Returns the serial of the first connected emulator, or null. */
  getEmulator(): string | null {
    if (this.serial) {
      const state = run(this.exePath, ["-s", this.serial, "get-state"]);
      return state.ok && state.stdout.trim() === "device" ? this.serial : null;
    }
    const line = this.devices().find(l => /^emulator-\d+\s+device/.test(l));
    return line ? line.split(/\s+/)[0] : null;
  }

  // ── Shell commands ────────────────────────────────────────────────────────

  /** Run a shell command, return trimmed stdout. */
  shell(cmd: string): string {
    return this.exec("shell", cmd).stdout.trim();
  }

  /**
   * Run a shell command as root.
   *
   * There are two distinct kinds of "rooted" device this lab targets:
   *   - `adb root`-rooted emulators (the default for this lab's own
   *     non-Play-Store system images): adbd itself restarts as root, the
   *     plain `adb shell` session is already uid=0, and there is usually
   *     no `su` binary installed at all.
   *   - Magisk/su-rooted devices (physical hardware, Play-Store images,
   *     rootAVD): the base shell is unprivileged; `su -c '<cmd>'` is
   *     required to elevate.
   *
   * Always wrapping in `su -c` (the previous behavior) silently no-ops on
   * the first kind — `su: not found` inside `adb shell`, but neither
   * `shell()` nor `rootShell()` surface exit codes, so callers like
   * `chmod 755 <frida-server>` would appear to succeed while doing
   * nothing. Detect which mode applies once (cached) and only pay the
   * `su -c` wrapping (with its extra quoting requirements) when it's
   * actually needed.
   *
   * Single-quotes in `cmd` must be pre-escaped by the caller (only
   * relevant in `su` mode).
   */
  rootShell(cmd: string): string {
    if (this.rootMode === null) {
      this.rootMode = /uid=0/.test(this.shell("id")) ? "adbroot" : "su";
    }
    return this.rootMode === "adbroot" ? this.shell(cmd) : this.shell(`su -c '${cmd}'`);
  }

  // ── File transfer ─────────────────────────────────────────────────────────

  /**
   * Push a local file to the device.
   * @param platform  Needed on WSL to convert Linux paths to Windows paths
   *                  when using the Windows adb.exe.
   */
  push(localPath: string, remotePath: string, platform?: PlatformInfo): void {
    let src = localPath;

    // WSL + Windows adb.exe: convert /mnt/c/... paths so Windows can find them.
    if (platform?.isWsl && this.exePath.endsWith(".exe")) {
      if (src.startsWith("/mnt/")) {
        // /mnt/c/foo → C:\foo — Windows adb handles native paths fine.
        src = toWinPath(src);
      }
      // Paths under WSL root (e.g. /home/user/...) are reachable from Windows
      // via \\wsl.localhost\<distro>\... but adb push doesn't handle UNC paths.
      // In that case, copy to /mnt/c/Windows/Temp first.
      if (!src.match(/^[A-Za-z]:\\/)) {
        const tmp = `/mnt/c/Windows/Temp/lab-push-${Date.now()}`;
        run("cp", [src, tmp]);
        src = toWinPath(tmp);
      }
    }

    const r = this.exec("push", src, remotePath);
    if (!r.ok) throw new Error(`adb push failed: ${r.stderr.trim()}`);
  }

  // ── Boot helpers ──────────────────────────────────────────────────────────

  /**
   * Wait (bounded) for the device to come online and finish booting.
   *
   * Deliberately does NOT use `adb wait-for-device` — that blocks forever
   * with no output at all if the emulator never registers (e.g. it failed
   * to start because hardware acceleration/WHPX isn't available on the
   * machine), which is exactly the "status not shown anything, stuck
   * pending" symptom reported on a different machine. Polling `get-state` +
   * `sys.boot_completed` within the configured timeout instead means a dead
   * launch always surfaces a clear, bounded error.
   */
  waitForBoot(timeoutSec = 300): void {
    log.info(`Waiting for Android boot (timeout ${timeoutSec}s)…`);
    const deadline = Date.now() + timeoutSec * 1_000;
    let sawDevice = false;
    while (Date.now() < deadline) {
      const state = this.exec("get-state");
      if (state.ok && state.stdout.trim() === "device") {
        sawDevice = true;
        if (this.shell("getprop sys.boot_completed") === "1") {
          process.stdout.write("\n");
          log.good("Android boot completed.");
          return;
        }
      }
      Bun.sleepSync(3_000);
      process.stdout.write(sawDevice ? "." : "o"); // 'o' = not visible to adb yet
    }
    process.stdout.write("\n");
    throw new Error(
      `Android did not boot within ${timeoutSec}s` +
      (sawDevice
        ? " (device connected but sys.boot_completed never reached 1)."
        : " (the emulator never connected to adb — check that hardware acceleration/virtualization is enabled: WHPX on Windows, VT-x/AMD-V in BIOS)."),
    );
  }

  /**
   * True if the on-device GPU renderer can actually produce a frame.
   *
   * Observed directly on this project's own machine: a fresh AVD can report
   * `sys.boot_completed=1` (boot genuinely finished) while the display is a
   * solid white/black/grey screen because the host-GPU-accelerated renderer
   * crashed — `adb shell screencap` fails with
   * `Assertion failed: !rcEnc->featureInfo()->hasReadColorBufferDma`. A
   * boot-timeout retry never catches this since boot itself succeeds; this
   * check is a separate, explicit renderer sanity check run right after
   * boot completes.
   */
  rendererHealthy(): boolean {
    const r = this.exec("shell", "screencap", "-p", "/data/local/tmp/.lab-render-check.png");
    const combined = `${r.stdout}${r.stderr}`;
    this.exec("shell", "rm", "-f", "/data/local/tmp/.lab-render-check.png");
    return r.ok && !/Assertion failed|Aborted/i.test(combined);
  }

  /**
   * Install a CA certificate into the system trust store WITHOUT needing a
   * writable /system, dm-verity disable, `-writable-system`, or any reboot.
   *
   * Technique (the standard modern one for rooted Android 10+/emulators):
   * mount a fresh tmpfs over /system/etc/security/cacerts, repopulate it
   * with the existing system CAs, then add ours — all with just `adb root`.
   * This sidesteps everything that made the old approach fragile:
   * `-writable-system` hung this image's boot, and `disable-verity` + reboot
   * hung the guest. The overlay lasts until the next reboot, which is fine
   * for a lab session (re-run to reapply).
   *
   * @param localDerPath  Local path to the CA in DER form.
   * @param hash          OpenSSL subject_hash_old of the cert (the on-device
   *                      filename is `<hash>.0`).
   * @param push          Callback that pushes a local file to a device path
   *                      (the caller owns adb push / WSL path translation).
   * @returns true if the cert is present in the system store afterward.
   */
  installSystemCert(
    localDerPath: string,
    hash: string,
    push: (local: string, remote: string) => void,
  ): boolean {
    // Ensure adbd is root (needed to mount tmpfs and write into /system).
    if (!/uid=0/.test(this.shell("id"))) this.exec("root");
    Bun.sleepSync(500);

    const tmpRemote = "/data/local/tmp/lab-system-ca.der";
    const destName = `${hash}.0`;
    push(localDerPath, tmpRemote);

    // If already present from a prior run this session, we're done.
    const already = this.rootShell(`test -f /system/etc/security/cacerts/${destName} && echo YES || true`).trim();
    if (already === "YES") {
      this.rootShell(`rm -f ${tmpRemote}`);
      return true;
    }

    // Overlay a tmpfs on the cacerts dir, repopulate with existing certs +
    // ours, then fix ownership/permissions/SELinux context.
    const script = [
      "set -e",
      "mkdir -p /data/local/tmp/lab-cacerts",
      "cp /system/etc/security/cacerts/* /data/local/tmp/lab-cacerts/ 2>/dev/null || true",
      "mount -t tmpfs tmpfs /system/etc/security/cacerts",
      "cp /data/local/tmp/lab-cacerts/* /system/etc/security/cacerts/ 2>/dev/null || true",
      `cp ${tmpRemote} /system/etc/security/cacerts/${destName}`,
      "chown root:root /system/etc/security/cacerts/*",
      "chmod 644 /system/etc/security/cacerts/*",
      "chcon u:object_r:system_security_cacerts_file:s0 /system/etc/security/cacerts/* 2>/dev/null || true",
      `rm -f ${tmpRemote}`,
      "rm -rf /data/local/tmp/lab-cacerts",
    ].join("; ");
    this.rootShell(script);

    const ok = this.rootShell(`test -f /system/etc/security/cacerts/${destName} && echo YES || true`).trim() === "YES";
    return ok;
  }

  // ── Device info ───────────────────────────────────────────────────────────

  getAbi(): string {
    const abi = this.shell("getprop ro.product.cpu.abi");
    if (!abi) throw new Error("Could not read ro.product.cpu.abi from device.");
    return abi;
  }

  getAndroidVersion(): string {
    return this.shell("getprop ro.build.version.release");
  }

  // ── Root verification ─────────────────────────────────────────────────────

  /**
   * Verify root is available, trying the cheapest method first.
   * Throws with a helpful message if the AVD is not rooted.
   */
  verifyRoot(): void {
    log.info("Verifying root…");
    let id = this.shell("id");
    log.info(`  adb shell id  → ${id}`);

    if (/uid=0/.test(id)) {
      log.good("ADB shell is root (userdebug image).");
      return;
    }

    // Non-Play-Store emulator system images (the lab's default
    // systemImageTag) are userdebug builds where `adb root` alone restarts
    // adbd as root — no Magisk/rootAVD needed. This is a no-op (and fails
    // harmlessly) on Play-Store images and real hardware, so it's always
    // safe to try before falling back to su.
    log.info("  adb shell id was not root — trying `adb root`…");
    this.exec("root");
    for (let i = 0; i < 10; i++) {
      Bun.sleepSync(500);
      if (this.getEmulator()) break; // adbd back online
    }
    id = this.shell("id");
    log.info(`  adb shell id  → ${id}`);
    if (/uid=0/.test(id)) {
      log.good("`adb root` grants root (userdebug emulator image).");
      return;
    }

    const su = this.shell("su -c id");
    log.info(`  su -c id      → ${su}`);

    if (/uid=0/.test(su)) {
      log.good("Magisk su grants root.");
      return;
    }

    throw new Error(
      "AVD is not rooted — frida-server requires root.\n\n" +
      "Root this AVD first, then rerun bootstrap.\n" +
      "Fastest method: rootAVD  →  https://github.com/newbit1/rootAVD\n" +
      "  1. Start the emulator manually\n" +
      "  2. Run rootAVD with your ramdisk path\n" +
      "  3. Reboot the emulator\n" +
      "  4. Rerun: bun run init",
    );
  }
}

// ── Factory / discovery ───────────────────────────────────────────────────────

/**
 * Locate the adb binary and return an Adb instance.
 *
 * Search order:
 *   1. Platform-tools inside `sdkRoot` (most reliable match)
 *   2. System PATH  (`adb` or `adb.exe`)
 *   3. WSL fallback — try native Linux `adb` if Windows one isn't found
 */
export function findAdb(platform: PlatformInfo, sdkRoot?: string, serial?: string): Adb {
  const candidates: string[] = [];

  if (sdkRoot) {
    candidates.push(join(sdkRoot, "platform-tools", `adb${platform.exe}`));
  }

  // PATH lookup
  candidates.push(`adb${platform.exe}`);

  // WSL: also try native Linux adb (no .exe suffix)
  if (platform.isWsl) candidates.push("adb");

  for (const candidate of candidates) {
    // For absolute paths, check existence; for bare names, probe the shell.
    const isAbsolute = candidate.includes("/") || candidate.includes("\\");
    if (isAbsolute) {
      if (!existsSync(candidate)) continue;
    } else {
      if (!run(candidate, ["--version"]).ok) continue;
    }
    log.good(`ADB: ${candidate}`);
    return new Adb(candidate, serial);
  }

  throw new Error(
    "adb not found.\n" +
    "  • Run with --install-sdk to download Android Platform Tools, or\n" +
    "  • Install Android Studio / SDK Platform Tools and rerun.",
  );
}

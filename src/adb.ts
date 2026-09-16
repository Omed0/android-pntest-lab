// ── ADB wrapper ───────────────────────────────────────────────────────────────
import { existsSync } from "fs";
import { join } from "path";
import { run, runOrFail } from "./exec.ts";
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

  waitForDevice(): void {
    const args = this.serial
      ? ["-s", this.serial, "wait-for-device"]
      : ["wait-for-device"];
    runOrFail(this.exePath, args);
  }

  waitForBoot(timeoutSec = 300): void {
    log.info(`Waiting for Android boot (timeout ${timeoutSec}s)…`);
    this.waitForDevice();

    const deadline = Date.now() + timeoutSec * 1_000;
    while (Date.now() < deadline) {
      if (this.shell("getprop sys.boot_completed") === "1") {
        process.stdout.write("\n");
        log.good("Android boot completed.");
        return;
      }
      Bun.sleepSync(3_000);
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    throw new Error(`Android did not boot within ${timeoutSec}s.`);
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

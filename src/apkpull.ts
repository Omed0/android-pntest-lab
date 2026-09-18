// ── Shared "find and pull installed APKs" logic ───────────────────────────────
//
// Used by transfer.ts (source -> target), run.ts (auto-recovery before
// launch), and extract.ts (pull for static analysis). Takes the actual adb
// invocation as a callback rather than a device/serial pair, so each caller
// can keep its own retry/wrapping behavior (transfer.ts retries transient
// post-boot binder errors; run.ts and extract.ts don't need to).

import { basename } from "path";
import type { RunResult } from "./exec.ts";

export type AdbRunner = (...args: string[]) => RunResult;

/** Resolve every APK path (base + splits) for an installed package, via `pm path`. */
export function packageApkPaths(adbRun: AdbRunner, pkg: string): string[] {
  const result = adbRun("shell", "pm", "path", pkg);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/)
    .map(line => line.trim().replace(/^package:/, ""))
    .filter(path => path.endsWith(".apk"));
}

export function packageInstalled(adbRun: AdbRunner, pkg: string): boolean {
  return packageApkPaths(adbRun, pkg).length > 0;
}

/**
 * Pull a single remote APK to a local path. Falls back to staging it via
 * `su -c cp` into /sdcard first when a direct pull fails — some split APK
 * directories (e.g. under /data/app/~~.../base.apk) aren't world-readable
 * even to adb's own shell user on certain Android versions/emulators.
 */
export function pullApk(adbRun: AdbRunner, remotePath: string, localPath: string): void {
  const result = adbRun("pull", remotePath, localPath);
  if (result.ok) return;
  const staged = `/sdcard/.android-pentest-lab-${basename(remotePath)}`;
  const stage = adbRun("shell", "su", "-c",
    `cp '${remotePath.replace(/'/g, "'\\''")}' '${staged}'`);
  if (!stage.ok) throw new Error(`Could not pull ${remotePath}: ${result.stderr.trim() || stage.stderr.trim()}`);
  const stagedPull = adbRun("pull", staged, localPath);
  adbRun("shell", "rm", "-f", staged);
  if (!stagedPull.ok) throw new Error(`Could not pull staged APK ${remotePath}: ${stagedPull.stderr.trim()}`);
}

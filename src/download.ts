// ── Download + extract helpers ────────────────────────────────────────────────
import { mkdirSync, existsSync, copyFileSync, unlinkSync, createWriteStream, readdirSync, renameSync, statSync } from "fs";
import { dirname, basename, join } from "path";
import { log } from "./log.ts";
import { run, runLive } from "./exec.ts";
import type { PlatformInfo } from "./platform.ts";
import type { LabConfig } from "./config.ts";

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download `url` to `destPath`, showing a progress bar.
 * Skips the download if the file already exists (cache-friendly).
 *
 * Retries a few times on a transient network drop mid-stream (observed
 * directly against both GitHub release assets and Adoptium's redirected
 * binary endpoint: "ECONNRESET"/"socket connection was closed unexpectedly"
 * partway through a large file) — a bare failure here previously aborted
 * the whole bootstrap on what's usually just a one-off network hiccup, with
 * no way to resume short of deleting the (incomplete, silently accepted as
 * "cached" by the existsSync() check above) partial file by hand.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  if (existsSync(destPath)) {
    log.good(`Already cached: ${basename(destPath)}`);
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });

  for (let attempt = 1; ; attempt++) {
    try {
      await downloadFileOnce(url, destPath);
      return;
    } catch (e) {
      if (existsSync(destPath)) unlinkSync(destPath); // never leave a partial file behind
      if (attempt >= 4) throw e;
      const message = e instanceof Error ? e.message : String(e);
      log.warn(`Download interrupted (${message}) — retrying (${attempt}/3)…`);
      Bun.sleepSync(2_000);
    }
  }
}

async function downloadFileOnce(url: string, destPath: string): Promise<void> {
  log.info(`Downloading ${basename(destPath)}`);
  log.info(`  → ${url}`);

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${url}`);

  const total   = parseInt(resp.headers.get("content-length") ?? "0", 10);
  // Use a Node fs.WriteStream (not Bun.file().writer()) and wait for its
  // "close" event — on Windows, Bun's FileSink can return from flush()/end()
  // before the OS file handle is actually released, which then races with
  // whatever reads the file next (e.g. 7-Zip extraction) and fails with
  // "the process cannot access the file because it is being used by another
  // process." fs.WriteStream's close event is a reliable fd-released signal.
  const fh      = createWriteStream(destPath);
  const reader  = resp.body!.getReader();
  let received  = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise<void>((resolve, reject) => {
        fh.write(value, (err) => (err ? reject(err) : resolve()));
      });
      received += value.length;
      if (total > 0) {
        const pct = Math.round((received / total) * 100);
        process.stdout.write(`\r  ${pct}%  (${mb(received)} / ${mb(total)} MB)   `);
      }
    }
  } finally {
    process.stdout.write("\n");
    await new Promise<void>((resolve) => fh.close(() => resolve()));
  }
  log.good(`Saved: ${destPath}`);
}

function mb(bytes: number) { return (bytes / 1_000_000).toFixed(1); }

// ── Extract .xz ───────────────────────────────────────────────────────────────

/**
 * Decompress a `.xz` file.
 * - Linux / macOS / WSL: uses system `xz`
 * - Windows: uses 7-Zip
 *
 * Returns the path to the decompressed file (archive path with .xz stripped).
 */
export async function extractXz(
  archivePath: string,
  outDir: string,
  platform: PlatformInfo,
  cfg?: LabConfig,
): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, basename(archivePath).replace(/\.xz$/, ""));

  if (existsSync(outFile)) {
    log.good(`Already extracted: ${basename(outFile)}`);
    return outFile;
  }

  log.info(`Extracting ${basename(archivePath)}…`);

  if (platform.type === "windows") {
    const z = find7z(cfg?.portable ? cfg : undefined);
    // Same transient-lock retry as extractZip() below — frida-server's .xz
    // is just as susceptible to a fresh-download antivirus lock.
    let r = run(z, ["x", archivePath, `-o${outDir}`, "-y"]);
    for (let i = 0; !r.ok && /being used by another process/i.test(r.stderr) && i < 5; i++) {
      log.warn(`Archive still locked, retrying extraction (${i + 1}/5)…`);
      Bun.sleepSync(1_500);
      r = run(z, ["x", archivePath, `-o${outDir}`, "-y"]);
    }
    if (!r.ok) throw new Error(`7-Zip failed: ${r.stderr}`);
  } else {
    // Stream-decompress to outFile so the .xz stays in place (no clobber).
    const proc = Bun.spawn(["xz", "--decompress", "--stdout", archivePath], {
      stdout: Bun.file(outFile),
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`xz failed (exit ${code}): ${err.trim()}`);
    }
  }

  log.good(`Extracted: ${outFile}`);
  return outFile;
}

// ── Extract .zip ──────────────────────────────────────────────────────────────

/**
 * Extract a `.zip` archive to `outDir`.
 * - Linux / macOS / WSL: `unzip` (with 7z as fallback)
 * - Windows: PowerShell `Expand-Archive` (with 7z as preferred override)
 */
export function extractZip(
  archivePath: string,
  outDir: string,
  platform: PlatformInfo,
  cfg?: LabConfig,
): void {
  mkdirSync(outDir, { recursive: true });
  log.info(`Extracting ${basename(archivePath)}…`);

  if (platform.type === "windows") {
    // 7-Zip is faster than PowerShell Expand-Archive for large zips.
    // A freshly-downloaded file can still be briefly locked on Windows
    // (antivirus real-time scan, or the OS not yet having released the
    // write handle) — retry a few times with a short backoff instead of
    // failing the whole SDK install on a transient lock.
    const z7 = try7z(cfg?.portable ? cfg : undefined);
    const attempt = () => z7
      ? run(z7, ["x", archivePath, `-o${outDir}`, "-y"])
      : run("powershell", [
          "-NoProfile", "-Command",
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`,
        ]);
    let r = attempt();
    for (let i = 0; !r.ok && /being used by another process/i.test(r.stderr) && i < 5; i++) {
      log.warn(`Archive still locked, retrying extraction (${i + 1}/5)…`);
      Bun.sleepSync(1_500);
      r = attempt();
    }
    if (!r.ok) throw new Error(`${z7 ? "7-Zip" : "Expand-Archive"} failed: ${r.stderr}`);
  } else {
    // Try unzip first; fall back to 7z if not installed.
    const r = run("unzip", ["-qo", archivePath, "-d", outDir]);
    if (!r.ok) {
      const r2 = run("7z", ["x", archivePath, `-o${outDir}`, "-y"]);
      if (!r2.ok) {
        throw new Error(
          "Cannot extract .zip — install unzip or 7-Zip.\n" +
          "  Ubuntu/Debian: sudo apt install unzip\n" +
          "  Arch:          sudo pacman -S unzip",
        );
      }
    }
  }

  log.good(`Extracted to: ${outDir}`);
}

/**
 * Extract a zip that wraps its real content in a single top-level versioned
 * folder (e.g. Temurin JRE zips extract as "jdk-21.0.5+11-jre/bin/...") and
 * flatten that folder's contents directly into `destDir`, so callers get a
 * stable path (`destDir/bin/java.exe`) regardless of the exact version
 * string baked into the archive's folder name. If the archive extracts flat
 * (no single wrapping folder — e.g. Python's embeddable zip), its contents
 * are used as-is.
 */
export function extractZipFlattenRoot(
  archivePath: string,
  destDir: string,
  platform: PlatformInfo,
  cfg?: LabConfig,
): void {
  const tmpDir = `${destDir}_tmp_extract`;
  mkdirSync(tmpDir, { recursive: true });
  extractZip(archivePath, tmpDir, platform, cfg);

  const entries = readdirSync(tmpDir);
  const sourceDir = entries.length === 1 && statSync(join(tmpDir, entries[0])).isDirectory()
    ? join(tmpDir, entries[0])
    : tmpDir;

  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const from = join(sourceDir, entry);
    const to = join(destDir, entry);
    // Same transient-lock class as elsewhere in this file — a few retries
    // instead of failing the whole install on a fresh-extract race.
    for (let i = 0; ; i++) {
      try {
        renameSync(from, to);
        break;
      } catch (e) {
        const isLock = e instanceof Error && /EPERM|EBUSY/.test((e as NodeJS.ErrnoException).code ?? "");
        if (!isLock || i >= 5) throw e;
        Bun.sleepSync(1_500);
      }
    }
  }

  run("rm", ["-rf", tmpDir]);
  run("powershell", ["-NoProfile", "-Command", `Remove-Item -Recurse -Force '${tmpDir}'`]);
}

// ── 7-Zip helpers (Windows / WSL) ────────────────────────────────────────────

/** Where a portable 7za.exe lands when ensure7z() downloads it in --portable mode. */
function portable7zPath(cfg?: LabConfig): string | null {
  return cfg ? join(cfg.toolsDir, "7zip-portable", "7za.exe") : null;
}

/**
 * Locate a usable 7-Zip executable.
 *
 * @param cfg  When passed with `portable: true`, ONLY the portable copy
 *   under tools/7zip-portable/ is considered — the host's own 7-Zip (on
 *   PATH or in Program Files), if any, is deliberately never used, per
 *   --portable's "don't borrow the host's own installs" contract. Pass
 *   `undefined` (or a non-portable cfg) for normal-mode lookup, which
 *   checks PATH and the usual Program Files locations instead.
 */
function try7z(cfg?: LabConfig): string | null {
  if (cfg?.portable) {
    const portable = portable7zPath(cfg);
    return portable && existsSync(portable) ? portable : null;
  }
  if (run("7z", ["i"]).ok) return "7z";
  const candidates = [
    process.env.ProgramFiles       && `${process.env.ProgramFiles}\\7-Zip\\7z.exe`,
    process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\7-Zip\\7z.exe`,
    process.env.LOCALAPPDATA       && `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\7z.exe`,
    "/mnt/c/Program Files/7-Zip/7z.exe",              // WSL
    "/mnt/c/Program Files (x86)/7-Zip/7z.exe",        // WSL
  ].filter(Boolean) as string[];
  return candidates.find(p => existsSync(p)) ?? null;
}

function find7z(cfg?: LabConfig): string {
  const p = try7z(cfg);
  if (!p) {
    throw new Error(
      "7-Zip is required on Windows. Install it with:\n" +
      "  winget install 7zip.7zip",
    );
  }
  return p;
}

/**
 * Ensure 7-Zip is available on Windows before it's needed.
 *
 * Two install strategies, chosen by `cfg.portable`:
 *   - Normal mode: auto-installs the real 7-Zip via winget when
 *     `--install-sdk` is set (same self-healing pattern as ensureJava() in
 *     src/sdk.ts and the Python bootstrap in src/frida.ts). This is a
 *     system-wide install.
 *   - Portable mode: downloads the old standalone "7-Zip Command Line
 *     Version" (7za.exe, a genuine .zip — not a .7z — so Expand-Archive can
 *     extract it without any 7z dependency already existing) into
 *     tools/7zip-portable/ and uses only that copy. Never touches the host's
 *     own 7-Zip install (if any) and never calls winget.
 *
 * No-op if a usable 7z is already found for the active mode, and a no-op if
 * `--install-sdk` isn't set in normal mode (extractZip() can still fall back
 * to Expand-Archive for .zip; only frida-server's .xz has no fallback).
 */
export async function ensure7z(cfg: LabConfig, platform: PlatformInfo): Promise<void> {
  if (platform.type !== "windows" || try7z(cfg.portable ? cfg : undefined)) return;

  if (cfg.portable) {
    log.info("7-Zip not found; downloading a portable copy (7za.exe) into tools/7zip-portable/…");
    const dest = join(cfg.toolsDir, "7zip-portable");
    mkdirSync(dest, { recursive: true });
    const zipFile = join(cfg.cacheDir, "7za920.zip");
    await downloadFile("https://www.7-zip.org/a/7za920.zip", zipFile);
    extractZip(zipFile, dest, platform);
    if (try7z(cfg)) {
      log.good(`Portable 7-Zip ready: ${portable7zPath(cfg)}`);
    } else {
      log.warn("Portable 7-Zip download did not produce a usable 7za.exe; will fall back to Expand-Archive for .zip (frida-server's .xz has no fallback).");
    }
    return;
  }

  if (!cfg.installSdk) return; // extractZip() can still fall back to Expand-Archive

  if (run("winget", ["--version"]).ok) {
    log.info("7-Zip not found; installing via winget…");
    const code = await runLive("winget", [
      "install", "--id", "7zip.7zip", "--exact",
      "--silent", "--accept-source-agreements", "--accept-package-agreements",
    ]);
    if (code === 0 && try7z()) {
      log.good("7-Zip installed.");
    } else {
      log.warn("Could not auto-install 7-Zip; will fall back to Expand-Archive for .zip (frida-server's .xz has no fallback).");
    }
  }
}

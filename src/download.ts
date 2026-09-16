// ── Download + extract helpers ────────────────────────────────────────────────
import { mkdirSync, existsSync, copyFileSync, unlinkSync, createWriteStream } from "fs";
import { dirname, basename, join } from "path";
import { log } from "./log.ts";
import { run, runLive } from "./exec.ts";
import type { PlatformInfo } from "./platform.ts";
import type { LabConfig } from "./config.ts";

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download `url` to `destPath`, showing a progress bar.
 * Skips the download if the file already exists (cache-friendly).
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  if (existsSync(destPath)) {
    log.good(`Already cached: ${basename(destPath)}`);
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });
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
  await new Promise<void>((resolve, reject) => {
    fh.close((err) => (err ? reject(err) : resolve()));
  });
  process.stdout.write("\n");
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
): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, basename(archivePath).replace(/\.xz$/, ""));

  if (existsSync(outFile)) {
    log.good(`Already extracted: ${basename(outFile)}`);
    return outFile;
  }

  log.info(`Extracting ${basename(archivePath)}…`);

  if (platform.type === "windows") {
    const z = find7z();
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
): void {
  mkdirSync(outDir, { recursive: true });
  log.info(`Extracting ${basename(archivePath)}…`);

  if (platform.type === "windows") {
    // 7-Zip is faster than PowerShell Expand-Archive for large zips.
    // A freshly-downloaded file can still be briefly locked on Windows
    // (antivirus real-time scan, or the OS not yet having released the
    // write handle) — retry a few times with a short backoff instead of
    // failing the whole SDK install on a transient lock.
    const z7 = try7z();
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

// ── 7-Zip helpers (Windows / WSL) ────────────────────────────────────────────

function try7z(): string | null {
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

function find7z(): string {
  const p = try7z();
  if (!p) {
    throw new Error(
      "7-Zip is required on Windows. Install it with:\n" +
      "  winget install 7zip.7zip",
    );
  }
  return p;
}

/**
 * Ensure 7-Zip is available on Windows before it's needed, auto-installing
 * via winget when `--install-sdk` is set (same self-healing pattern as
 * ensureJava() in src/sdk.ts and the Python bootstrap in src/frida.ts).
 * No-op on non-Windows platforms, and a no-op if 7-Zip is already present
 * (extractZip() already has an Expand-Archive fallback for .zip, but there
 * is no fallback for .xz — frida-server's archive format — so this matters
 * even when only the .zip path would otherwise limp along without it).
 */
export async function ensure7z(cfg: LabConfig, platform: PlatformInfo): Promise<void> {
  if (platform.type !== "windows" || try7z()) return;

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

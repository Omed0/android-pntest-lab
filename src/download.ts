// ── Download + extract helpers ────────────────────────────────────────────────
import { mkdirSync, existsSync, copyFileSync, unlinkSync } from "fs";
import { dirname, basename, join } from "path";
import { log } from "./log.ts";
import { run } from "./exec.ts";
import type { PlatformInfo } from "./platform.ts";

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
  const writer  = Bun.file(destPath).writer();
  const reader  = resp.body!.getReader();
  let received  = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      process.stdout.write(`\r  ${pct}%  (${mb(received)} / ${mb(total)} MB)   `);
    }
  }
  await writer.flush();
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
    const r = run(z, ["x", archivePath, `-o${outDir}`, "-y"]);
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
    const z7 = try7z();
    if (z7) {
      const r = run(z7, ["x", archivePath, `-o${outDir}`, "-y"]);
      if (!r.ok) throw new Error(`7-Zip failed: ${r.stderr}`);
    } else {
      const r = run("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`,
      ]);
      if (!r.ok) throw new Error(`Expand-Archive failed: ${r.stderr}`);
    }
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

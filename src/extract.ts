#!/usr/bin/env bun
// ── APK extraction + sensitive-data scanning ──────────────────────────────────
//
// For a given package (installed on an emulator, or a local APK), pull every
// split, unzip it, optionally decompile it with jadx, scan everything for
// hardcoded secrets, detect which SSL-pinning technique(s) it uses, and write
// up a REPORT.md. Formalizes the ad-hoc layout this project already used once
// by hand under testing/tarik-e2e/ (pulled_apks/, extracted/, evidence/) into
// a repeatable command: testing/<pkg>/{pulled_apks,extracted,decompiled}/ +
// REPORT.md, generated automatically every run.
//
// Usage
//   bun run extract -- --package=<pkg>
//   bun run extract -- --package=<pkg> --device=source
//   bun run extract -- --apk=./apk/Tarik.apk
//   bun run extract -- --package=<pkg> --out=testing/custom-name --no-scan
//
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from "fs";
import { join, basename, extname, relative } from "path";
import { detectPlatform } from "./platform.ts";
import { loadConfig } from "./config.ts";
import { findAdb } from "./adb.ts";
import { log, fail } from "./log.ts";
import { run, which } from "./exec.ts";
import { extractZip } from "./download.ts";
import { resolveApkInfo } from "./apkinfo.ts";
import { packageApkPaths, pullApk } from "./apkpull.ts";
import { ensureSdk, ensureJadx } from "./sdk.ts";
import {
  scanString,
  extractPrintableStrings,
  type SecretMatch,
} from "./secrets.ts";
import {
  detectPinningSignatures,
  generateCustomHookStub,
  type PinningSignature,
} from "./unpinning.ts";

interface ExtractOptions {
  package?: string;
  apk?: string;
  device: string;
  out?: string;
  jadx: boolean;
  noScan: boolean;
}

function parseArgs(argv: string[]): ExtractOptions {
  const options: ExtractOptions = {
    device: "target",
    jadx: true,
    noScan: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--no-scan") {
      options.noScan = true;
      continue;
    }
    if (arg === "--no-jadx") {
      options.jadx = false;
      continue;
    }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case "package":
        options.package = value;
        break;
      case "apk":
        options.apk = value;
        break;
      case "device":
        options.device = value ?? options.device;
        break;
      case "out":
        options.out = value;
        break;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`
Android Pentest Lab - extract

Pull an app's APK(s), extract + (optionally) decompile them, scan for
hardcoded secrets, and detect its SSL-pinning technique(s).

Usage
  bun run extract -- --package=<pkg> [--device=target|source|<serial>]
  bun run extract -- --apk=<path>
  bun run extract -- --package=<pkg> --out=<dir> [--no-scan] [--no-jadx]

Options
  --package=<pkg>   Package to pull from a running emulator
  --apk=<path>      Use a local APK instead of pulling from a device
  --device=<which>  target | source | a literal serial [target]
  --out=<dir>       Output root [testing/<pkg>/]
  --no-scan         Skip the secret/pinning scan, just pull + extract
  --no-jadx         Skip Java decompilation even if jadx is on PATH
  --help            Show this help

Output layout (testing/<pkg>/ by default, already git-ignored):
  pulled_apks/   Raw APK split(s), as found on the device
  extracted/     Unzipped APK contents (manifest, dex, resources, assets)
  decompiled/    Java sources from jadx, if available
  REPORT.md      Findings: secrets, pinning detection, next steps
`);
}

/**
 * Run JADX safely on Windows.
 *
 * IMPORTANT:
 * Do not use the project's `run()` helper here for the .bat launcher.
 * That helper escapes quotes for its shell layer, which produces `\"...\"`
 * and breaks cmd.exe when the path contains spaces.
 *
 * We invoke cmd.exe directly with Bun.spawnSync(), so the command string
 * reaches cmd.exe unchanged.
 */
function normalizeWindowsExecutablePath(value: string): string {
  // Some Windows command-resolution helpers return a quoted path (and older
  // versions of this lab could even return shell-escaped quotes). Passing
  // that value through another quoting layer produces:
  //   "\\\"D:\\path with spaces\\jadx.bat\\\""
  // which cmd.exe treats as a literal executable name.
  let normalized = value.trim();
  while (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("\\'") && normalized.endsWith("\\'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/\\"/g, '"');
  normalized = normalized.replace(/\\'/g, "'");
  return normalized;
}

function runJadx(jadx: string, args: string[]) {
  jadx = normalizeWindowsExecutablePath(jadx);

  if (process.platform !== "win32" || !/\.bat$/i.test(jadx)) {
    return run(jadx, args);
  }

  // Pass jadx and each arg as separate elements so Bun's CreateProcess quoting
  // handles paths with spaces correctly. `call` is only needed inside a .bat
  // calling another .bat; cmd.exe /c can invoke a .bat directly.
  const proc = Bun.spawnSync(["cmd.exe", "/d", "/c", jadx, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();

  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

// .xml is deliberately excluded: inside a raw-extracted APK, res/**/*.xml and
// AndroidManifest.xml are compiled binary AXML, not text (confirmed live —
// reading them as UTF-8 produced garbage matches full of replacement
// characters). jadx's default -d run (no --no-res) does decode them to real
// text; those live under decompiled/res and are read as text there via this
// same extension check, since decompiledDir is scanned as its own root.
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".txt",
  ".properties",
  ".java",
  ".kt",
  ".js",
  ".html",
  ".yml",
  ".yaml",
  ".cfg",
  ".ini",
  ".md",
]);
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".ogg",
  ".zip",
  ".webm",
]);

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function scanTree(rootDirs: string[]): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();
  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    for (const file of walkFiles(root)) {
      const ext = extname(file).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) continue;
      const relPath = relative(root, file);
      let text: string;
      if (TEXT_EXTENSIONS.has(ext)) {
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
      } else {
        const size = statSync(file).size;
        if (size > 50 * 1024 * 1024) continue; // skip huge binaries (e.g. bundled native libs)
        text = extractPrintableStrings(readFileSync(file)).join("\n");
      }
      for (const m of scanString(text, relPath)) {
        const key = `${m.pattern}::${m.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(m);
      }
    }
  }
  return matches;
}

function writeReport(
  outDir: string,
  pkg: string,
  info: { versionName?: string; versionCode?: string } | null,
  pulledApks: string[],
  extractedDir: string,
  decompiledDir: string | null,
  matches: SecretMatch[],
  signatures: PinningSignature[],
  generatedStub: string | null,
): void {
  const byCategory = new Map<string, SecretMatch[]>();
  for (const m of matches) {
    if (!byCategory.has(m.category)) byCategory.set(m.category, []);
    byCategory.get(m.category)!.push(m);
  }

  const lines: string[] = [];
  lines.push(`# Extraction report: ${pkg}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (info?.versionName)
    lines.push(
      `Version: ${info.versionName}${info.versionCode ? ` (code ${info.versionCode})` : ""}`,
    );
  lines.push("");
  lines.push("## Files");
  lines.push("");
  for (const p of pulledApks)
    lines.push(`- Pulled APK: \`${relative(outDir, p)}\``);
  lines.push(`- Extracted contents: \`${relative(outDir, extractedDir)}\``);
  if (decompiledDir)
    lines.push(
      `- Decompiled sources (jadx): \`${relative(outDir, decompiledDir)}\``,
    );
  else
    lines.push(
      `- Decompiled sources: not generated (jadx not found on PATH, or --no-jadx passed)`,
    );
  lines.push("");

  lines.push("## Pinning detection");
  lines.push("");
  if (signatures.length === 0) {
    lines.push(
      "No known pinning-library fingerprints found in the extracted dex/resources.",
    );
  } else {
    lines.push("| Technique | Status | Evidence |");
    lines.push("|---|---|---|");
    for (const s of signatures)
      lines.push(`| ${s.label} | ${s.status} | ${s.evidence} |`);
    lines.push("");
    lines.push("Status meanings:");
    lines.push(
      "- `covered` — the default HTTPToolkit suite (`scripts/unpinning/`) already handles this.",
    );
    lines.push(
      "- `verify-manually` — partially handled; capture traffic and confirm it's actually unpinned.",
    );
    lines.push(
      "- `needs-custom` — a dynamic per-app runtime hook was generated to attempt the relevant Java-layer bypasses.",
    );
  }

  if (generatedStub) {
    lines.push("");
    lines.push(
      `Generated automatic dynamic hook: \`${relative(outDir, generatedStub)}\`. It is loaded automatically by \`bun run.ts --package=${pkg}\`.`,
    );
  }
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  if (matches.length === 0) {
    lines.push(
      "No matches from the built-in secret-pattern list. This does not mean the app has none — it means the static patterns in `src/secrets.ts` didn't match anything in the extracted/decompiled text.",
    );
  } else {
    for (const [category, items] of byCategory) {
      lines.push(`### ${category} (${items.length})`);
      lines.push("");
      lines.push("| Pattern | Value | Source file |");
      lines.push("|---|---|---|");
      for (const m of items) {
        const value = m.value.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
        lines.push(`| ${m.pattern} | \`${value}\` | \`${m.file}\` |`);
      }
      lines.push("");
    }
    lines.push(
      '`generic-credential-like` matches are a broad heuristic (any `key: "value"` shape near words like token/secret/password) — treat them as leads to verify, not confirmed secrets.',
    );
  }
  lines.push("");

  lines.push("## Suggested next steps");
  lines.push("");
  lines.push(
    `- Capture live traffic alongside these static findings: \`bun run run -- --package=${pkg}\``,
  );
  if (matches.some((m) => m.category === "urls" || m.category === "ips")) {
    lines.push(
      "- Check whether any hardcoded hosts/IPs above are internal/staging endpoints reachable from this network.",
    );
  }
  lines.push(
    "- This report and everything under `testing/` is git-ignored — it stays local unless you copy it out.",
  );

  Bun.write(join(outDir, "REPORT.md"), lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  if (!options.package && !options.apk)
    fail("--package=<pkg> or --apk=<path> is required.");

  const labRoot = join(import.meta.dir, "..");
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot, process.argv.slice(2));

  let pkg = options.package;
  const pulledApks: string[] = [];
  let apkInfo: ReturnType<typeof resolveApkInfo> = null;

  if (!pkg && options.apk) {
    if (!existsSync(options.apk)) fail(`APK not found: ${options.apk}`);
    apkInfo = resolveApkInfo(cfg.sdkRoot, platform, options.apk);
    if (apkInfo) {
      pkg = apkInfo.packageName;
    } else {
      // No aapt/apkanalyzer available (SDK not installed yet) — still let
      // extraction/scanning proceed using the filename as a folder name
      // rather than hard-failing on a purely cosmetic naming step.
      pkg = basename(options.apk)
        .replace(/\.apk$/i, "")
        .replace(/[^A-Za-z0-9._-]/g, "_");
      log.warn(
        `Could not read the real package name (need aapt/aapt2 or apkanalyzer — run \`bun run init -- --install-sdk\`). Using '${pkg}' as a folder name instead.`,
      );
    }
  }
  if (!pkg) fail("Could not resolve a package name.");

  const outDir = options.out ?? join(labRoot, "testing", pkg);
  const pulledDir = join(outDir, "pulled_apks");
  const extractedDir = join(outDir, "extracted");
  const decompiledDir = join(outDir, "decompiled");
  mkdirSync(pulledDir, { recursive: true });

  console.log("\nAndroid Pentest Lab - extract");
  console.log(`  Package: ${pkg}`);
  console.log(`  Output:  ${outDir}\n`);

  if (options.apk) {
    const dest = join(pulledDir, basename(options.apk));
    copyFileSync(options.apk, dest);
    pulledApks.push(dest);
    log.good(`Copied local APK: ${basename(options.apk)}`);
  } else {
    const serial =
      options.device === "target"
        ? cfg.targetSerial
        : options.device === "source"
          ? cfg.sourceSerial
          : options.device;
    const adbTool = findAdb(platform, cfg.sdkRoot, serial);
    adbTool.startServer();
    const adbRun = (...args: string[]) =>
      run(adbTool.exePath, ["-s", serial, ...args]);
    const remotePaths = packageApkPaths(adbRun, pkg);
    if (remotePaths.length === 0)
      fail(`Package '${pkg}' is not installed on device '${serial}'.`);
    log.good(`Found ${remotePaths.length} APK file(s) on ${serial}.`);
    for (const remotePath of remotePaths) {
      const localPath = join(pulledDir, basename(remotePath));
      log.info(`Pulling ${basename(remotePath)}…`);
      pullApk(adbRun, remotePath, localPath);
      pulledApks.push(localPath);
    }
    apkInfo = resolveApkInfo(cfg.sdkRoot, platform, pulledApks[0]);
  }

  log.step("Extract");
  if (existsSync(extractedDir))
    rmSync(extractedDir, { recursive: true, force: true });
  for (const apkPath of pulledApks) {
    extractZip(apkPath, extractedDir, platform, cfg);
  }
  log.good(
    `Extracted ${pulledApks.length} APK(s) into ${relative(labRoot, extractedDir)}`,
  );

  let decompiledOut: string | null = null;

  if (options.jadx) {
    log.step("Decompile");

    /*
     * Search for an existing JADX first.
     *
     * If --install-sdk was supplied and JADX is missing, ensureJadx()
     * downloads the project-local copy into tools/jadx/.
     */
    const jadx =
      which("jadx") ?? which("jadx.bat") ?? (await ensureJadx(cfg, platform));

    if (!jadx) {
      log.info(
        "jadx not found — using raw-strings scan only.\n" +
          "  Run: bun run extract -- --package=<pkg> --install-sdk",
      );
    } else {
      if (existsSync(decompiledDir)) {
        rmSync(decompiledDir, {
          recursive: true,
          force: true,
        });
      }

      const base = pulledApks[0];

      log.info(
        `Running jadx on ${basename(base)}… ` +
          "(this can take a while for large apps)",
      );

      const r = runJadx(jadx, ["-d", decompiledDir, "--no-res", base]);

      if (r.ok || existsSync(decompiledDir)) {
        decompiledOut = decompiledDir;

        log.good(
          `Decompiled sources written to ` +
            `${relative(labRoot, decompiledDir)}`,
        );
      } else {
        log.info(
          `jadx failed to produce output ` +
            `(${r.stderr.trim().slice(0, 200) || "unknown error"}) — ` +
            "continuing without decompiled sources.",
        );
      }
    }
  }

  let matches: SecretMatch[] = [];
  let signatures: PinningSignature[] = [];
  let generatedStub: string | null = null;
  if (!options.noScan) {
    log.step("Scan");
    matches = scanTree([
      extractedDir,
      ...(decompiledOut ? [decompiledOut] : []),
    ]);
    log.good(
      `Found ${matches.length} unique match(es) from the built-in secret patterns.`,
    );

    signatures = detectPinningSignatures(extractedDir);

    if (signatures.length > 0) {
      log.info(
        `Pinning signatures detected: ${signatures
          .map((s) => `${s.label} (${s.status})`)
          .join(", ")}`,
      );
    } else {
      log.warn(
        "No known static pinning fingerprints matched. " +
          "Generating the dynamic runtime hook anyway; custom, obfuscated, " +
          "native, or dynamically loaded pinning may still be present.",
      );
    }

    // Always generate the app-specific dynamic hook.
    // The *.auto.js file is generated and may be overwritten on every extract.
    generatedStub = generateCustomHookStub(labRoot, pkg, signatures);

    log.good(
      `Generated dynamic per-app hook: ${relative(labRoot, generatedStub)}`,
    );
  }

  writeReport(
    outDir,
    pkg,
    apkInfo,
    pulledApks,
    extractedDir,
    decompiledOut,
    matches,
    signatures,
    generatedStub,
  );
  log.good(`Report written: ${relative(labRoot, join(outDir, "REPORT.md"))}`);
}

if (import.meta.main) {
  main().catch((error) => {
    log.blank();
    fail(error instanceof Error ? error.message : String(error));
  });
}

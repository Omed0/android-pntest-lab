#!/usr/bin/env bun
// ── APK inspector — quickly get a package name (and version/activity) ──────────
//
// The transfer / run / e2e commands all need an app's *package name*, which is
// not the APK filename. This reads it straight out of the APK so you don't
// have to install it first or dig through Play Store URLs.
//
// Usage
//   bun run apkinfo -- --apk=apk/Tarik.apk
//   bun run apkinfo -- apk/alwatani.apk
//   bun run apkinfo -- --apk=apk/Tarik.apk --quiet   # print only the package name
//
// It uses whichever of these the installed SDK provides (no extra downloads):
//   1. aapt / aapt2  (from build-tools, if present) — one call gives package,
//      version, and launchable activity.
//   2. apkanalyzer   (from cmdline-tools, always installed by this lab) —
//      fallback that yields package name + version without build-tools.
//
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { detectPlatform } from "./platform.ts";
import type { PlatformInfo } from "./platform.ts";
import { loadConfig } from "./config.ts";
import { run } from "./exec.ts";
import { log, fail } from "./log.ts";

export interface ApkInfo {
  packageName: string;
  versionName?: string;
  versionCode?: string;
  launchActivity?: string;
}

// ── Tool discovery ──────────────────────────────────────────────────────────

/** Newest build-tools aapt/aapt2 in the SDK, or null if build-tools absent. */
export function findAapt(sdkRoot: string, platform: PlatformInfo): string | null {
  const btRoot = join(sdkRoot, "build-tools");
  if (!existsSync(btRoot)) return null;
  const versions = readdirSync(btRoot).sort().reverse(); // newest first
  for (const v of versions) {
    for (const name of ["aapt2", "aapt"]) {
      const p = join(btRoot, v, `${name}${platform.exe}`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function apkanalyzerPath(sdkRoot: string, platform: PlatformInfo): string {
  const ext = platform.type === "windows" || platform.type === "wsl" ? ".bat" : "";
  return join(sdkRoot, "cmdline-tools", "latest", "bin", `apkanalyzer${ext}`);
}

// ── Extraction ──────────────────────────────────────────────────────────────

export function fromAapt(aapt: string, apk: string): ApkInfo | null {
  // Both aapt2 and classic aapt accept identical "dump badging <apk>" args.
  const r = run(aapt, ["dump", "badging", apk]);
  if (!r.ok || !r.stdout.includes("package:")) return null;
  const out = r.stdout;
  const pkg = out.match(/package:\s*name='([^']+)'/)?.[1];
  if (!pkg) return null;
  return {
    packageName: pkg,
    versionName: out.match(/versionName='([^']*)'/)?.[1],
    versionCode: out.match(/versionCode='([^']*)'/)?.[1],
    launchActivity: out.match(/launchable-activity:\s*name='([^']+)'/)?.[1],
  };
}

export function fromApkanalyzer(tool: string, apk: string): ApkInfo | null {
  const pkg = run(tool, ["manifest", "application-id", apk]);
  if (!pkg.ok) return null;
  const packageName = pkg.stdout.trim().split(/\r?\n/).pop()?.trim();
  if (!packageName) return null;
  const versionName = run(tool, ["manifest", "version-name", apk]).stdout.trim().split(/\r?\n/).pop()?.trim();
  const versionCode = run(tool, ["manifest", "version-code", apk]).stdout.trim().split(/\r?\n/).pop()?.trim();
  return { packageName, versionName, versionCode };
}

/** Resolve package name/version from a local APK file, trying aapt then apkanalyzer. Used by run.ts, transfer.ts, and extract.ts. */
export function resolveApkInfo(sdkRoot: string, platform: PlatformInfo, apk: string): ApkInfo | null {
  const aapt = findAapt(sdkRoot, platform);
  let info: ApkInfo | null = aapt ? fromAapt(aapt, apk) : null;
  if (!info) {
    const analyzer = apkanalyzerPath(sdkRoot, platform);
    if (existsSync(analyzer)) info = fromApkanalyzer(analyzer, apk);
  }
  return info;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { apk?: string; quiet: boolean } {
  let apk: string | undefined;
  let quiet = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    if (arg === "--quiet" || arg === "-q") { quiet = true; continue; }
    const m = arg.match(/^--apk=(.*)$/);
    if (m) { apk = m[1]; continue; }
    if (!arg.startsWith("--")) apk = arg; // positional path
  }
  return { apk, quiet };
}

function printHelp(): void {
  console.log(`
Android Pentest Lab - apkinfo

Print an APK's package name (and version / launch activity) without installing it.

Usage
  bun run apkinfo -- --apk=<path>
  bun run apkinfo -- <path>
  bun run apkinfo -- --apk=<path> --quiet   # only the package name (for scripting)

Then feed the package name to run/transfer, e.g.:
  bun run transfer -- --package=<name>
`);
}

async function main(): Promise<void> {
  const { apk, quiet } = parseArgs(process.argv);
  if (!apk) fail("--apk=<path-to-apk> is required.  Example: bun run apkinfo -- --apk=apk/Tarik.apk");
  if (!existsSync(apk!)) fail(`APK not found: ${apk}`);

  const labRoot = join(import.meta.dir, "..");
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot, []);

  const info = resolveApkInfo(cfg.sdkRoot, platform, apk!);

  if (!info) {
    fail(
      "Could not read the package name.\n" +
      "  Need either build-tools (aapt/aapt2) or cmdline-tools (apkanalyzer) in the SDK.\n" +
      "  Install with: bun run init -- --install-sdk",
    );
  }

  if (quiet) {
    console.log(info!.packageName);
    return;
  }

  console.log("");
  log.good(`Package:  ${info!.packageName}`);
  if (info!.versionName) log.info(`Version:  ${info!.versionName}${info!.versionCode ? ` (code ${info!.versionCode})` : ""}`);
  if (info!.launchActivity) log.info(`Activity: ${info!.launchActivity}`);
  console.log("");
  log.info(`Next:  bun run transfer -- --package=${info!.packageName}`);
  log.info(`  or:  bun run run -- --package=${info!.packageName} --apk=${apk}`);
}

// Guard against running the CLI as a side effect of importing this file's
// exported helpers (extract.ts does exactly that) — only run when this file
// is the actual entry point Bun was invoked with.
if (import.meta.main) {
  main().catch(err => {
    log.blank();
    fail(err instanceof Error ? err.message : String(err));
  });
}

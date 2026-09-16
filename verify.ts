#!/usr/bin/env bun
// ── Android Pentest Lab — verify ──────────────────────────────────────────────
//
// Quick health-check.  Run this any time to confirm everything is working.
//
//   ✓ Host Frida version
//   ✓ ADB device list
//   ✓ Android version + ABI
//   ✓ Root access check
//   ✓ frida-server processes on device
//   ✓ frida-ps -U (host ↔ device Frida communication)
//   ✓ Burp proxy setting on device
//
// Usage
// ─────
//   bun verify.ts
//   bun verify.ts --verbose
//
// ─────────────────────────────────────────────────────────────────────────────

import { log, fail } from "./src/log.ts";
import { detectPlatform } from "./src/platform.ts";
import { loadConfig } from "./src/config.ts";
import { findAdb } from "./src/adb.ts";
import { activatePortablePython, getHostFridaVersion } from "./src/frida.ts";
import { run } from "./src/exec.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkMark(ok: boolean): string {
  return ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
}

function pad(s: string, width = 24): string {
  return s.padEnd(width);
}

function printRow(label: string, value: string, ok: boolean): void {
  console.log(`  ${checkMark(ok)}  ${pad(label)} ${value}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verbose  = process.argv.includes("--verbose") || process.argv.includes("-v");
  const labRoot  = import.meta.dir;
  const platform = detectPlatform();
  const cfg      = loadConfig(labRoot);
  activatePortablePython(cfg);

  console.log("\n\x1b[1m╔══════════════════════════════════════╗\x1b[0m");
  console.log(  "\x1b[1m║    Android Pentest Lab — Verify      ║\x1b[0m");
  console.log(  "\x1b[1m╚══════════════════════════════════════╝\x1b[0m\n");

  let allOk = true;

  // ── 1. Host Frida ──────────────────────────────────────────────────────────
  console.log("\x1b[1m── Host tools ───────────────────────────\x1b[0m");

  const fridaVersion = getHostFridaVersion();
  const fridaOk = !!fridaVersion;
  printRow("frida (host)", fridaVersion ?? "NOT FOUND", fridaOk);
  if (!fridaOk) allOk = false;

  const fridaPsCheck = run("frida-ps", ["--version"]);
  printRow("frida-ps (host)", fridaPsCheck.stdout.trim() || "NOT FOUND", fridaPsCheck.ok);
  if (!fridaPsCheck.ok) allOk = false;

  // ── 2. ADB ─────────────────────────────────────────────────────────────────
  console.log("\n\x1b[1m── ADB / Device ─────────────────────────\x1b[0m");

  let adb: ReturnType<typeof findAdb> | null = null;
  try {
    adb = findAdb(platform, cfg.sdkRoot, cfg.targetSerial);
    adb.startServer();
    printRow("adb", adb.exePath, true);
  } catch (e) {
    printRow("adb", "NOT FOUND", false);
    allOk = false;
    console.log("\n  No ADB — cannot check device. Run: bun run init\n");
    summarize(allOk);
    return;
  }

  const emulator = adb.getEmulator();
  const emulatorOk = !!emulator;
  printRow("emulator", emulator ?? "none connected", emulatorOk);
  if (!emulatorOk) {
    allOk = false;
    console.log("\n  No emulator — start the lab first: bun run init\n");
    summarize(allOk);
    return;
  }

  // ── 3. Android info ────────────────────────────────────────────────────────
  const booted = adb.shell("getprop sys.boot_completed") === "1";
  printRow("boot_completed", booted ? "1 (fully booted)" : "0 (still booting)", booted);
  if (!booted) allOk = false;

  if (booted) {
    const androidVer = adb.getAndroidVersion();
    const abi        = adb.getAbi();
    printRow("Android version", androidVer || "unknown", !!androidVer);
    printRow("ABI", abi || "unknown", !!abi);
  }

  // ── 4. Root ────────────────────────────────────────────────────────────────
  console.log("\n\x1b[1m── Root ─────────────────────────────────\x1b[0m");

  const idShell = adb.shell("id");
  const isRootShell = /uid=0/.test(idShell);
  printRow("adb shell id", idShell || "(empty)", isRootShell);

  const idSu = adb.shell("su -c id");
  const isSuRoot = /uid=0/.test(idSu);
  printRow("su -c id", idSu || "(empty)", isSuRoot);

  const rootOk = isRootShell || isSuRoot;
  if (!rootOk) {
    allOk = false;
    log.warn("No root — frida-server requires root. Root the AVD first.");
  }

  // ── 5. frida-server on device ──────────────────────────────────────────────
  console.log("\n\x1b[1m── frida-server (device) ────────────────\x1b[0m");

  // List all frida-server processes
  const fsProcs = adb.rootShell("ps -A 2>/dev/null | grep frida-server || true");
  if (fsProcs.trim()) {
    const lines = fsProcs.trim().split(/\r?\n/);
    for (const line of lines) {
      printRow("frida-server proc", line.trim(), true);
    }
  } else {
    printRow("frida-server proc", "none running", false);
    allOk = false;
  }

  // Check versioned binary exists on device
  if (fridaVersion) {
    const remotePath = `${cfg.fridaRemoteDir}/frida-server-${fridaVersion}`;
    const exists = adb.rootShell(
      `if [ -f ${remotePath} ] && [ -x ${remotePath} ]; then echo OK; else echo MISSING; fi`
    );
    printRow(`binary on device`, `${remotePath}  [${exists}]`, exists === "OK");
    if (exists !== "OK") allOk = false;

    if (verbose && exists === "OK") {
      const devVer = adb.rootShell(`${remotePath} --version 2>/dev/null || true`);
      printRow("  device version", devVer || "(none)", devVer.includes(fridaVersion));
    }
  }

  // ── 6. frida-ps -U ────────────────────────────────────────────────────────
  console.log("\n\x1b[1m── Frida communication ──────────────────\x1b[0m");

  const fridaPsU = run("frida-ps", ["-D", cfg.targetSerial]);
  const commOk = fridaPsU.ok;
  printRow(`frida-ps -D ${cfg.targetSerial}`, commOk ? "OK" : "FAILED", commOk);
  if (!commOk) {
    allOk = false;
    log.warn(`frida-ps -U stderr: ${fridaPsU.stderr.trim()}`);
  } else if (verbose) {
    // Print the process list
    console.log("\n  Running processes on device:");
    const lines = fridaPsU.stdout.trim().split(/\r?\n/);
    for (const line of lines.slice(0, 20)) {
      console.log(`    ${line}`);
    }
    if (lines.length > 20) {
      console.log(`    … and ${lines.length - 20} more`);
    }
  }

  // ── 7. Proxy setting (Burp by default) ─────────────────────────────────────
  console.log("\n\x1b[1m── Proxy ────────────────────────────────\x1b[0m");

  const proxyVal = adb.shell("settings get global http_proxy 2>/dev/null || true").trim();
  const expectedProxy = `${cfg.burpHost}:${cfg.burpPort}`;
  const proxySet = proxyVal === expectedProxy;
  printRow("http_proxy (device)", proxyVal || "(not set)", proxySet);
  if (!proxySet) {
    log.info(`  Expected: ${expectedProxy}`);
    log.info("  Set it with: bun run.ts --package=<pkg>  (or just bun run init)");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  summarize(allOk);
}

function summarize(allOk: boolean): void {
  console.log();
  if (allOk) {
    console.log("\x1b[32m\x1b[1m┌──────────────────────────────────────┐\x1b[0m");
    console.log("\x1b[32m\x1b[1m│         ✓  LAB HEALTHY               │\x1b[0m");
    console.log("\x1b[32m\x1b[1m└──────────────────────────────────────┘\x1b[0m");
  } else {
    console.log("\x1b[31m\x1b[1m┌──────────────────────────────────────┐\x1b[0m");
    console.log("\x1b[31m\x1b[1m│         ✗  ISSUES FOUND              │\x1b[0m");
    console.log("\x1b[31m\x1b[1m│  Run: bun run init to fix them       │\x1b[0m");
    console.log("\x1b[31m\x1b[1m└──────────────────────────────────────┘\x1b[0m");
  }
  console.log();
}

main().catch(err => {
  log.blank();
  fail(err instanceof Error ? err.message : String(err));
});

#!/usr/bin/env bun
// Android Pentest Lab bootstrap: SDK, target AVD, root, and Frida.

import { log, fail } from "../src/log.ts";
import { detectPlatform } from "../src/platform.ts";
import { loadConfig, printConfig } from "../src/config.ts";
import { ensureSdk } from "../src/sdk.ts";
import { ensureAvd, startEmulator } from "../src/avd.ts";
import { findAdb } from "../src/adb.ts";
import {
  ensureFridaHost,
  getFridaServer,
  deployFridaServer,
  verifyFridaConnection,
} from "../src/frida.ts";

async function main(): Promise<void> {
  const labRoot = `${import.meta.dir}/..`;
  const platform = detectPlatform();
  const cfg = loadConfig(labRoot);

  console.log("\n\x1b[1m╔══════════════════════════════════════╗\x1b[0m");
  console.log("  \x1b[1m║    Android Pentest Lab — Bootstrap   ║\x1b[0m");
  console.log("  \x1b[1m╚══════════════════════════════════════╝\x1b[0m");
  console.log(`  Platform: ${platform.type}${platform.isWsl ? " (WSL)" : ""}`);
  printConfig(cfg);
  log.blank();

  const sdkRoot = await ensureSdk(cfg, platform);
  cfg.sdkRoot = sdkRoot;
  ensureAvd(cfg, platform);

  const adb = findAdb(platform, sdkRoot, cfg.targetSerial);
  adb.startServer();
  const emulatorAlreadyUp = !!adb.getEmulator();

  if (!emulatorAlreadyUp && !cfg.skipEmulator) {
    await startEmulator(cfg, platform);
    Bun.sleepSync(2_000);
  } else if (emulatorAlreadyUp) {
    log.good(`Target emulator already connected: ${cfg.targetSerial}`);
  } else {
    log.warn("--skip-emulator set and target emulator is not connected.");
  }

  adb.waitForBoot(cfg.emulatorBootTimeoutSec);

  log.step("Root");
  adb.verifyRoot();

  const fridaVersion = await ensureFridaHost(cfg);
  log.step("frida-server");
  const abi = adb.getAbi();
  log.info(`Device ABI: ${abi}`);
  const serverPath = await getFridaServer(fridaVersion, abi, cfg, platform);
  await deployFridaServer(adb, serverPath, fridaVersion, cfg, platform, cfg.forceFrida);

  log.step("Final check");
  verifyFridaConnection(cfg.targetSerial);

  log.blank();
  log.good("LAB READY");
  console.log(`  AVD     : ${cfg.avdName}  (Android ${adb.getAndroidVersion()})`);
  console.log(`  ABI     : ${abi}`);
  console.log(`  Frida   : ${fridaVersion}`);
  console.log(`  Burp    : ${cfg.burpHost}:${cfg.burpPort}`);
}

main().catch(error => {
  log.blank();
  fail(error instanceof Error ? error.message : String(error));
});

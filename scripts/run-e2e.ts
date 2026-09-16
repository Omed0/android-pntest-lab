#!/usr/bin/env bun
// End-to-end lab runner: initialize both emulators, then run the target app.

import { runLive } from "../src/exec.ts";
import { fail, log } from "../src/log.ts";

function valueFor(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`
Android Pentest Lab - run-e2e.ts

Initialize both emulator roles, recover/install the target package, configure
Burp and the CA certificate, launch the app, and attach Frida.

Usage
  bun scripts/run-e2e.ts --package=<pkg> [options]

Examples
  bun scripts/run-e2e.ts --package=com.example.app
  bun scripts/run-e2e.ts --package=com.example.app --apk=./apk/app.apk
  bun scripts/run-e2e.ts --package=com.example.app --install-sdk
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const pkg = valueFor(args, "--package");
  if (!pkg) fail("--package=<app.package.name> is required.\n\n  Example: bun run e2e -- --package=com.example.app");

  const runOnlyFlags = new Set([
    "--package", "--apk", "--main-activity", "--frida-script", "--burp-cert",
    "--no-burp", "--spawn", "--verbose", "-v",
  ]);
  const initArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const key = arg.split("=", 1)[0];
    if (runOnlyFlags.has(key)) {
      if (!arg.includes("=") && ["--package", "--apk", "--main-activity", "--frida-script", "--burp-cert"].includes(arg)) index++;
      continue;
    }
    initArgs.push(arg);
  }
  if (!args.includes("--no-install-sdk") && !initArgs.includes("--install-sdk")) initArgs.push("--install-sdk");

  log.step("End-to-end initialization");
  const initCode = await runLive("bun", ["scripts/initialize-lab.ts", ...initArgs]);
  if (initCode !== 0) throw new Error(`initialize-lab.ts failed with exit code ${initCode}.`);

  log.step("End-to-end application run");
  const runCode = await runLive("bun", ["run.ts", ...args]);
  if (runCode !== 0) throw new Error(`run.ts failed with exit code ${runCode}.`);
}

main().catch(error => {
  log.blank();
  fail(error instanceof Error ? error.message : String(error));
});

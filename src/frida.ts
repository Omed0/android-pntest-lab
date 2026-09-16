// ── Frida host install + device deploy ────────────────────────────────────────
import { existsSync } from "fs";
import { join, basename } from "path";
import { log } from "./log.ts";
import { run, runLive } from "./exec.ts";
import { downloadFile, extractXz } from "./download.ts";
import type { Adb } from "./adb.ts";
import type { LabConfig } from "./config.ts";
import type { PlatformInfo } from "./platform.ts";

function fridaDeviceArgs(serial: string): string[] {
  return ["-D", serial];
}

// ── Host Frida ────────────────────────────────────────────────────────────────

/** Return the installed host Frida version string, or null if not installed. */
export function getHostFridaVersion(): string | null {
  // Try bare name first (on PATH), then the pip user-install location.
  const candidates = [
    "frida",
    `${process.env.HOME ?? ""}/.local/bin/frida`,
  ];
  for (const cmd of candidates) {
    const r = run(cmd, ["--version"]);
    if (r.ok) {
      const v = r.stdout.trim();
      if (/^\d+\.\d+\.\d+/.test(v)) return v;
    }
  }
  return null;
}

/**
 * Ensure Frida host tools (frida, frida-ps, frida-trace …) are installed
 * via pip.  Installs/upgrades only if not already present.
 * Returns the installed version string.
 */
export async function ensureFridaHost(cfg: LabConfig): Promise<string> {
  log.step("Frida host");

  const current = getHostFridaVersion();
  if (current && cfg.fridaVersion === "auto") {
    log.good(`Frida host already installed: ${current}`);
    return current;
  }

  if (current && cfg.fridaVersion !== "auto" && current === cfg.fridaVersion && !cfg.forceFrida) {
    log.good(`Frida host already at requested version: ${current}`);
    return current;
  }

  const pkg = cfg.fridaVersion === "auto"
    ? "frida frida-tools"
    : `frida==${cfg.fridaVersion} frida-tools`;

  log.info(`Installing Frida host: ${pkg}`);

  // Try standard Python launchers first, then install Python on Windows.
  const pipCommands: Array<[string, string[]]> = [
    ["pip3", ["install", "--upgrade", ...pkg.split(" ")]],
    ["pip", ["install", "--upgrade", ...pkg.split(" ")]],
    ["python", ["-m", "pip", "install", "--upgrade", ...pkg.split(" ")]],
    ["py", ["-m", "pip", "install", "--upgrade", ...pkg.split(" ")]],
  ];

  for (const [pip, args] of pipCommands) {
    const r = run(pip, args);
    if (r.ok) {
      const v = getHostFridaVersion();
      if (v) {
        log.good(`Frida host installed: ${v}`);
        return v;
      }
    }
  }

  if (process.platform === "win32" && run("winget", ["--version"]).ok) {
    log.info("Python/pip not found; installing Python with winget…");
    const installCode = await runLive("winget", [
      "install", "--id", "Python.Python.3.13", "--exact",
      "--silent", "--accept-source-agreements", "--accept-package-agreements",
    ]);
    if (installCode === 0) {
      for (const [pip, args] of pipCommands.slice(2)) {
        const r = run(pip, args);
        if (r.ok) {
          const v = getHostFridaVersion();
          if (v) {
            log.good(`Frida host installed: ${v}`);
            return v;
          }
        }
      }
    }
  }

  throw new Error(
    "Could not install Frida via pip.\n" +
    "Make sure Python and pip are installed:\n" +
    "  Windows: winget install Python.Python.3.13\n" +
    "  Linux:   sudo apt install python3 python3-pip",
  );
}

// ── frida-server binary ───────────────────────────────────────────────────────

/** Map ABI strings from `ro.product.cpu.abi` to Frida's naming convention. */
function abiToFridaArch(abi: string): string {
  if (/^x86_64$/.test(abi))     return "x86_64";
  if (/^x86$/.test(abi))        return "x86";
  if (/^arm64/.test(abi))       return "arm64";
  if (/^armeabi/.test(abi))     return "arm";
  throw new Error(
    `Unsupported ABI '${abi}' for Frida server download.\n` +
    "Supported: x86_64, x86, arm64-v8a, armeabi-v7a",
  );
}

/**
 * Download (and cache) the matching frida-server binary.
 * Returns the local path to the decompressed binary.
 */
export async function getFridaServer(
  version: string,
  abi: string,
  cfg: LabConfig,
  platform: PlatformInfo,
): Promise<string> {
  const arch     = abiToFridaArch(abi);
  const name     = `frida-server-${version}-android-${arch}`;
  const xzFile   = join(cfg.cacheDir, `${name}.xz`);
  const binFile  = join(cfg.fridaDir, name);

  if (existsSync(binFile)) {
    log.good(`frida-server cached: ${binFile}`);
    return binFile;
  }

  const url = `https://github.com/frida/frida/releases/download/${version}/${name}.xz`;
  await downloadFile(url, xzFile);
  await extractXz(xzFile, cfg.fridaDir, platform);

  if (!existsSync(binFile)) {
    throw new Error(`Expected extracted binary not found: ${binFile}`);
  }

  log.good(`frida-server ready: ${binFile}`);
  return binFile;
}

// ── Device deploy ─────────────────────────────────────────────────────────────

/**
 * Push frida-server to the device and start it as a root daemon.
 *
 * Remote path: `<fridaRemoteDir>/frida-server-<version>`
 * This versioned name avoids the "Is a directory" error from a
 * previous failed push that left a directory entry at the path.
 */
export async function deployFridaServer(
  adb: Adb,
  serverPath: string,
  version: string,
  cfg: LabConfig,
  platform: PlatformInfo,
  force = false,
): Promise<void> {
  log.step("Deploy frida-server");

  const remote = `${cfg.fridaRemoteDir}/frida-server-${version}`;

  // ── Check what's already on the device ────────────────────────────────────

  const typeCheck = adb.rootShell(
    `if [ -f ${remote} ]; then echo FILE; elif [ -d ${remote} ]; then echo DIR; else echo MISSING; fi`
  );

  if (typeCheck === "DIR") {
    log.warn(`${remote} is a directory — removing it before push.`);
    adb.rootShell(`rm -rf ${remote}`);
  }

  // ── Check for a running server at exactly this version ────────────────────

  if (!force && typeCheck !== "MISSING") {
    const runningPid = adb.rootShell(`pidof frida-server-${version} 2>/dev/null || true`).trim();
    if (runningPid) {
      log.info(`frida-server-${version} already running (PID=${runningPid}). Verifying…`);
      const check = run("frida-ps", fridaDeviceArgs(cfg.targetSerial));
      if (check.ok) {
        log.good("Existing frida-server is reachable — skipping redeploy.");
        return;
      }
      log.warn("Existing server not reachable — killing and restarting.");
      adb.rootShell(`pkill -f frida-server-${version} 2>/dev/null || true`);
    }
  }

  // ── Push the binary if needed ─────────────────────────────────────────────

  const needPush = force || typeCheck !== "FILE";
  if (needPush) {
    log.info(`Pushing frida-server-${version}…`);
    adb.push(serverPath, remote, platform);
  } else {
    log.good("Matching binary already on device.");
  }

  // ── Set permissions ───────────────────────────────────────────────────────

  adb.rootShell(`chmod 755 ${remote}`);

  const sanity = adb.rootShell(
    `if [ -f ${remote} ] && [ -x ${remote} ]; then echo OK; else echo BAD; fi`
  );
  if (sanity !== "OK") {
    throw new Error(`Remote binary is not executable: ${remote}`);
  }

  // ── Smoke-test the binary ─────────────────────────────────────────────────

  log.info("Testing frida-server binary on device…");
  const deviceVersion = adb.rootShell(`${remote} --version`);
  if (!deviceVersion.includes(version)) {
    throw new Error(
      `Device binary version mismatch.\n` +
      `  Expected: ${version}\n` +
      `  Device:   ${deviceVersion || "(no output)"}`,
    );
  }
  log.good(`Device frida-server version: ${deviceVersion}`);

  // ── Start as root daemon ──────────────────────────────────────────────────

  adb.rootShell(`pkill -f frida-server-${version} 2>/dev/null || true`);
  const logFile = `${cfg.fridaRemoteDir}/frida-server-${version}.log`;
  adb.rootShell(`nohup ${remote} >${logFile} 2>&1 </dev/null &`);
  Bun.sleepSync(2_000);

  let pid = adb.rootShell(`pidof frida-server-${version} 2>/dev/null || true`).trim();
  if (!pid) {
    Bun.sleepSync(2_000);
    pid = adb.rootShell(`pidof frida-server-${version} 2>/dev/null || true`).trim();
  }

  if (!pid) {
    const logContent = adb.rootShell(`cat ${logFile} 2>/dev/null || true`);
    throw new Error(
      `frida-server exited immediately.\n` +
      `Device log:\n${logContent || "(empty)"}`,
    );
  }

  log.good(`frida-server-${version} running as root (PID=${pid}).`);
}

// ── Connectivity verification ─────────────────────────────────────────────────

/** Verify target-specific frida-ps connectivity. Throws if not. */
export function verifyFridaConnection(serial: string): void {
  log.info(`Running frida-ps -D ${serial}…`);
  const r = run("frida-ps", fridaDeviceArgs(serial));
  if (!r.ok) {
    throw new Error(
      `frida-ps -D ${serial} failed — frida-server may not be running or ADB is not connected.\n` +
      r.stderr.trim(),
    );
  }
  log.good("Frida host ↔ device connection verified.");
}

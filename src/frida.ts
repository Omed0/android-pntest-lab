// ── Frida host install + device deploy ────────────────────────────────────────
import { existsSync, readdirSync } from "fs";
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

// ── Python discovery (Windows PATH is unreliable right after install) ─────────

/**
 * Locate a working Python interpreter without assuming PATH is current.
 *
 * A Python that's genuinely installed (via winget, the python.org installer,
 * or the Microsoft Store) is frequently still invisible to `run("python",
 * ...)`/`run("py", ...)` in an *already-running* shell/process — Windows
 * only broadcasts the PATH change to new processes, and winget itself will
 * happily report "already installed, no upgrade needed" while the current
 * session still can't resolve it. Bare-name PATH lookups alone therefore
 * cannot tell "not installed" apart from "installed, but this process can't
 * see it yet" — which is exactly what produced a confusing "Could not
 * install Frida via pip" error for an operator who already had Python.
 *
 * This checks bare names first (cheap, works when PATH is fine), then scans
 * the same install locations winget/python.org/the Store actually use, the
 * same pattern already used for 7-Zip in src/download.ts's try7z().
 */
function findPythonExe(): string | null {
  for (const cmd of ["python", "python3", "py"]) {
    if (run(cmd, ["--version"]).ok) return cmd;
  }

  const local = process.env.LOCALAPPDATA;
  const candidates: string[] = [];
  if (local) {
    candidates.push(`${local}\\Microsoft\\WindowsApps\\python3.exe`);
    candidates.push(`${local}\\Microsoft\\WindowsApps\\python.exe`);
    // python.org / winget installs: LOCALAPPDATA\Programs\Python\Python3XX\python.exe
    const programsDir = `${local}\\Programs\\Python`;
    if (existsSync(programsDir)) {
      try {
        for (const entry of readdirSync(programsDir)) {
          candidates.push(`${programsDir}\\${entry}\\python.exe`);
        }
      } catch { /* ignore */ }
    }
  }
  if (process.env.ProgramFiles) {
    candidates.push(`${process.env.ProgramFiles}\\Python3\\python.exe`);
  }

  return candidates.find(p => existsSync(p) && run(p, ["--version"]).ok) ?? null;
}

/**
 * Prepend a Python interpreter's own directory and its Scripts/bin
 * directory to this process's PATH so bare `pip`/`frida`/`frida-ps` calls
 * (here and in run.ts/verify.ts/etc., which all assume PATH) work for the
 * rest of this run — even when the OS-level PATH hasn't been refreshed for
 * this already-running process (see findPythonExe() above).
 */
function addToProcessPath(exePath: string): void {
  const dir = exePath.includes("\\") || exePath.includes("/")
    ? exePath.slice(0, Math.max(exePath.lastIndexOf("\\"), exePath.lastIndexOf("/")))
    : null;
  if (!dir) return; // bare command name already on PATH — nothing to add
  const sep = process.platform === "win32" ? ";" : ":";
  const scriptsDir = process.platform === "win32" ? `${dir}\\Scripts` : `${dir}/../bin`;
  const additions = [dir, scriptsDir].filter(p => existsSync(p));
  if (additions.length === 0) return;
  process.env.PATH = `${additions.join(sep)}${sep}${process.env.PATH ?? ""}`;
}

/**
 * Ensure Frida host tools (frida, frida-ps, frida-trace …) are installed
 * via pip.  Installs/upgrades only if not already present.
 * Returns the installed version string.
 */
export async function ensureFridaHost(cfg: LabConfig): Promise<string> {
  log.step("Frida host");

  let current = getHostFridaVersion();
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

  // Find whatever Python is genuinely already on this machine before ever
  // considering installing a new one — see findPythonExe() for why a bare
  // PATH check alone isn't enough to tell "not installed" from "installed,
  // but this process can't see it yet".
  let pythonExe = findPythonExe();
  if (pythonExe) {
    addToProcessPath(pythonExe);
    log.good(`Using existing Python: ${pythonExe}`);
  } else if (process.platform === "win32" && run("winget", ["--version"]).ok) {
    log.info("No usable Python found; installing one with winget…");
    await runLive("winget", [
      "install", "--id", "Python.Python.3.13", "--exact",
      "--silent", "--accept-source-agreements", "--accept-package-agreements",
    ]);
    pythonExe = findPythonExe();
    if (pythonExe) addToProcessPath(pythonExe);
  }

  if (!pythonExe) {
    throw new Error(
      "Could not find or install Python.\n" +
      "  Windows: winget install Python.Python.3.13\n" +
      "  Linux:   sudo apt install python3 python3-pip\n" +
      "  macOS:   brew install python3",
    );
  }

  log.info(`Installing Frida host: ${pkg}`);
  const install = run(pythonExe, ["-m", "pip", "install", "--upgrade", ...pkg.split(" ")]);
  current = getHostFridaVersion();
  if (install.ok && current) {
    log.good(`Frida host installed: ${current}`);
    return current;
  }

  throw new Error(
    "Could not install Frida via pip, even with a working Python found at:\n" +
    `  ${pythonExe}\n` +
    (install.stderr.trim() || install.stdout.trim() || "(pip reported success but 'frida --version' still isn't runnable — check PATH.)"),
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

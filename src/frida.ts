// ── Frida host install + device deploy ────────────────────────────────────────
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { log } from "./log.ts";
import { run, runLive } from "./exec.ts";
import { downloadFile, extractXz, extractZip } from "./download.ts";
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

// ── Portable Python (embeddable package, no host install/winget) ──────────────

const PORTABLE_PYTHON_VERSION = "3.12.7";

function portablePythonExe(cfg: LabConfig): string {
  return join(cfg.toolsDir, "python", "python.exe");
}

/**
 * Download the official Python "embeddable package" zip into tools/python/
 * and bootstrap pip into it — used only in --portable mode, so the host's
 * own Python (if any) is never touched and winget is never invoked. Unlike
 * a normal install, the embeddable package ships without pip and with
 * `import site` disabled by default (needed for pip-installed packages
 * under Lib/site-packages to be importable), so both are fixed up here.
 */
async function ensurePortablePython(cfg: LabConfig, platform: PlatformInfo): Promise<string> {
  const exe = portablePythonExe(cfg);
  if (existsSync(exe)) return exe;

  if (platform.type !== "windows") {
    throw new Error(
      "--portable Python install is only implemented for Windows right now.\n" +
      "Install Python normally on this platform (e.g. sudo apt install python3 python3-pip) and rerun without --portable.",
    );
  }

  log.info("Portable mode: downloading a private Python into tools/python/ (the host's own Python, if any, is left untouched)…");
  const dest = join(cfg.toolsDir, "python");
  mkdirSync(dest, { recursive: true });
  const url = `https://www.python.org/ftp/python/${PORTABLE_PYTHON_VERSION}/python-${PORTABLE_PYTHON_VERSION}-embed-amd64.zip`;
  const zipFile = join(cfg.cacheDir, `python-${PORTABLE_PYTHON_VERSION}-embed-amd64.zip`);
  await downloadFile(url, zipFile);
  extractZip(zipFile, dest, platform, cfg); // embeddable zip is already flat, no wrapping folder
  if (!existsSync(exe)) throw new Error(`Portable Python download did not produce ${exe}`);

  for (const file of readdirSync(dest).filter(f => /^python\d+\._pth$/.test(f))) {
    const pthPath = join(dest, file);
    writeFileSync(pthPath, readFileSync(pthPath, "utf8").replace(/^#\s*import site/m, "import site"));
  }

  log.info("Bootstrapping pip into the portable interpreter…");
  const getPip = join(cfg.cacheDir, "get-pip.py");
  await downloadFile("https://bootstrap.pypa.io/get-pip.py", getPip);
  const pipBootstrap = run(exe, [getPip, "--no-warn-script-location"]);
  if (!pipBootstrap.ok) {
    throw new Error(`Could not bootstrap pip for the portable Python:\n${pipBootstrap.stderr.trim() || pipBootstrap.stdout.trim()}`);
  }

  log.good(`Portable Python ready: ${exe}`);
  return exe;
}

/**
 * Point this process at an already-downloaded portable Python (tools/python/)
 * without downloading or installing anything. Call this at the top of any
 * standalone entry point (run.ts, verify.ts) that needs `frida`/`frida-ps`
 * to resolve after a prior `--portable` bootstrap — each `bun <script>.ts`
 * invocation is a fresh process, so the PATH addition ensureFridaHost() made
 * during bootstrap doesn't carry over on its own. No-op if not in portable
 * mode or if the portable Python hasn't been installed yet.
 */
export function activatePortablePython(cfg: LabConfig): void {
  if (!cfg.portable) return;
  const exe = portablePythonExe(cfg);
  if (existsSync(exe)) addToProcessPath(exe);
}

/**
 * Ensure Frida host tools (frida, frida-ps, frida-trace …) are installed
 * via pip.  Installs/upgrades only if not already present.
 * Returns the installed version string.
 */
export async function ensureFridaHost(cfg: LabConfig, platform: PlatformInfo): Promise<string> {
  log.step("Frida host");

  let current = getHostFridaVersion();
  if (current && cfg.fridaVersion === "auto" && !cfg.portable) {
    log.good(`Frida host already installed: ${current}`);
    return current;
  }

  if (current && cfg.fridaVersion !== "auto" && current === cfg.fridaVersion && !cfg.forceFrida && !cfg.portable) {
    log.good(`Frida host already at requested version: ${current}`);
    return current;
  }

  const pkg = cfg.fridaVersion === "auto"
    ? "frida frida-tools"
    : `frida==${cfg.fridaVersion} frida-tools`;

  let pythonExe: string | null;
  if (cfg.portable) {
    // Never fall back to whatever Python the host already has — download
    // and use a private copy under tools/python/ only.
    pythonExe = await ensurePortablePython(cfg, platform);
    addToProcessPath(pythonExe);
    log.good(`Using portable Python: ${pythonExe}`);
  } else {
    // Find whatever Python is genuinely already on this machine before ever
    // considering installing a new one — see findPythonExe() for why a bare
    // PATH check alone isn't enough to tell "not installed" from "installed,
    // but this process can't see it yet".
    pythonExe = findPythonExe();
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
  }

  if (!pythonExe) {
    throw new Error(
      "Could not find or install Python.\n" +
      "  Windows: winget install Python.Python.3.13\n" +
      "  Linux:   sudo apt install python3 python3-pip\n" +
      "  macOS:   brew install python3",
    );
  }

  // Portable Python is a fresh interpreter every time tools/python/ doesn't
  // already have it — Frida is never pre-installed on it, so the "already
  // installed" shortcuts above don't apply; re-check here instead.
  if (cfg.portable) {
    current = getHostFridaVersion();
    if (current && cfg.fridaVersion === "auto") return current;
    if (current && cfg.fridaVersion !== "auto" && current === cfg.fridaVersion && !cfg.forceFrida) return current;
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
  await extractXz(xzFile, cfg.fridaDir, platform, cfg);

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
  // A binary that's just been pushed+chmod'd on a device that was JUST
  // rooted/booted (the from-scratch case: clean -> init) can transiently
  // produce empty output on the very first exec attempt — observed
  // directly right after a fresh AVD's `adb root` grant, even though the
  // file existence/executable-bit sanity check above already passed.
  // Retry a few times with a short backoff before treating it as a real
  // version mismatch/corrupt binary.
  let deviceVersion = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    deviceVersion = adb.rootShell(`${remote} --version`);
    if (deviceVersion.includes(version)) break;
    if (attempt < 4) {
      log.warn(`frida-server --version gave no/unexpected output (attempt ${attempt}/4) — retrying…`);
      Bun.sleepSync(1_500);
    }
  }
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

// ── Subprocess helpers (Bun-native, cross-platform) ───────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
}

// ── Synchronous ───────────────────────────────────────────────────────────────

/** Run a command, capture stdout/stderr. Never throws on non-zero exit.
 *  Returns { ok: false, exitCode: 127 } if the executable is not found. */
export function run(cmd: string, args: string[] = [], opts: RunOpts = {}): RunResult {
  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: opts.env ? { ...process.env as Record<string,string>, ...opts.env } : process.env as Record<string,string>,
    });
    return {
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
      exitCode: proc.exitCode ?? 1,
      ok: (proc.exitCode ?? 1) === 0,
    };
  } catch (e) {
    // Bun.spawnSync throws ENOENT when the executable is not found.
    return {
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: 127,   // conventional "command not found"
      ok: false,
    };
  }
}

/** Run and throw a descriptive Error on non-zero exit. Returns trimmed stdout. */
export function runOrFail(cmd: string, args: string[] = [], opts: RunOpts = {}): string {
  const r = run(cmd, args, opts);
  if (!r.ok) {
    const detail = (r.stderr.trim() || r.stdout.trim()).slice(0, 400);
    throw new Error(
      `Command failed (exit ${r.exitCode}): ${cmd} ${args.join(" ")}` +
      (detail ? `\n${detail}` : ""),
    );
  }
  return r.stdout.trim();
}

// ── Async (live stdio) ────────────────────────────────────────────────────────

/** Run with the user's terminal attached — output is visible in real time. */
export async function runLive(
  cmd: string,
  args: string[] = [],
  opts: RunOpts = {},
): Promise<number> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin:  "inherit",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env as Record<string,string>, ...opts.env } : process.env as Record<string,string>,
  });
  return proc.exited;
}

/**
 * Run a command that reads stdin interactively (e.g. sdkmanager --licenses).
 * Supply `stdinData` to auto-answer prompts.
 */
export async function runWithStdin(
  cmd: string,
  args: string[],
  stdinData: string,
  opts: RunOpts = {},
): Promise<RunResult> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin:  "pipe",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env as Record<string,string>, ...opts.env } : process.env as Record<string,string>,
  });
  proc.stdin!.write(stdinData);
  proc.stdin!.end();

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
  ]);
  await proc.exited;

  return {
    stdout: Buffer.from(stdoutBuf).toString(),
    stderr: Buffer.from(stderrBuf).toString(),
    exitCode: proc.exitCode ?? 1,
    ok: (proc.exitCode ?? 1) === 0,
  };
}

// ── Background (fire-and-forget) ──────────────────────────────────────────────

/**
 * Spawn a process in the background. The child keeps running after the
 * parent script exits (Bun does not kill unreaped children on exit).
 * Returns the Bun subprocess handle — caller may store .pid.
 */
export function spawnBackground(cmd: string, args: string[], opts: RunOpts = {}): Bun.Subprocess {
  return Bun.spawn([cmd, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    stdin:  "ignore",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env as Record<string,string>, ...opts.env } : process.env as Record<string,string>,
  });
}

/** Resolve the full path of a CLI tool, or null if not found. */
export function which(name: string): string | null {
  const r = run(process.platform === "win32" ? "where" : "which", [name]);
  if (!r.ok) return null;
  const first = r.stdout.split(/\r?\n/)[0].trim();
  return first || null;
}

// ── Wait for a genuinely unavoidable manual step ───────────────────────────
//
// Some steps in this lab really do require a human — e.g. Android's own
// security model requires a live tap to approve a new su client, which no
// amount of automation can fake without defeating the point of that
// approval. Rather than failing the whole bootstrap the instant such a
// check doesn't pass yet, this polls patiently: print clear instructions
// once, keep checking, remind the user periodically that it's still
// waiting (not stuck), and let the caller decide what a genuine timeout
// means. Not specific to any one step — reusable wherever this pattern is
// needed.

import { log } from "./log.ts";

export interface WaitForManualStepOptions {
  /** Printed once, up front, as separate lines. */
  instructions: string[];
  /** Polled repeatedly; return true once the manual step is done. */
  checkFn: () => boolean | Promise<boolean>;
  /** Seconds between checks. Default 5. */
  pollIntervalSec?: number;
  /** Seconds between "still waiting" reminder lines. Default 30. */
  reminderEverySec?: number;
  /** Give up after this many seconds and return false. Default 900 (15 min). */
  timeoutSec?: number;
}

/**
 * Poll `checkFn()` until it returns true or `timeoutSec` elapses.
 * Returns true if the manual step was completed in time, false on timeout —
 * the caller decides whether that's fatal (throw) or just a warning.
 */
export async function waitForManualStep(opts: WaitForManualStepOptions): Promise<boolean> {
  const pollIntervalSec = opts.pollIntervalSec ?? 5;
  const reminderEverySec = opts.reminderEverySec ?? 30;
  const timeoutSec = opts.timeoutSec ?? 900;

  log.warn("Manual step needed — this will keep waiting and continue automatically once it's done:");
  for (const line of opts.instructions) log.info(`  ${line}`);

  const deadline = Date.now() + timeoutSec * 1_000;
  let lastReminder = Date.now();

  while (Date.now() < deadline) {
    if (await checkOnce(opts.checkFn)) return true;

    Bun.sleepSync(pollIntervalSec * 1_000);

    if (Date.now() - lastReminder >= reminderEverySec * 1_000) {
      const remainingMin = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
      log.info(`  … still waiting (about ${remainingMin} min left before giving up).`);
      lastReminder = Date.now();
    }
  }

  return checkOnce(opts.checkFn);
}

async function checkOnce(checkFn: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await checkFn();
  } catch {
    return false;
  }
}

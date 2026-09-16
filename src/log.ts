// ── Coloured terminal output ──────────────────────────────────────────────────

const R  = "\x1b[0m";   // reset
const C  = "\x1b[36m";  // cyan
const G  = "\x1b[32m";  // green
const Y  = "\x1b[33m";  // yellow
const RE = "\x1b[31m";  // red
const B  = "\x1b[1m";   // bold

export const log = {
  /** Informational step. */
  info:  (msg: string) => console.log(`${C}[*] ${msg}${R}`),
  /** Success / verified. */
  good:  (msg: string) => console.log(`${G}[+] ${msg}${R}`),
  /** Non-fatal warning. */
  warn:  (msg: string) => console.log(`${Y}[!] ${msg}${R}`),
  /** Major section header. */
  step:  (msg: string) => console.log(`\n${B}══ ${msg} ══${R}`),
  blank: ()            => console.log(),
};

/** Print an error and exit with code 1. Never returns. */
export function fail(msg: string): never {
  console.error(`${RE}[✗] ${msg}${R}`);
  process.exit(1);
}

// ── Static secret/sensitive-data pattern library ──────────────────────────────
//
// Used by extract.ts to scan a decompiled/extracted APK tree for hardcoded
// secrets. This is a lab tool scanning your own test targets, not a CI
// security gate, so patterns favor recall over precision — findings are
// reported with the category that matched, and the deliberately broad
// "generic-credential-like" pattern is labeled as a heuristic rather than a
// confirmed secret so a reader can tell the difference at a glance.

export interface SecretPattern {
  name: string;
  category: string;
  regex: RegExp;
}

// Order matters only for readability of the exported list — extract.ts runs
// every pattern over every string and dedupes by (name, value), so an
// overlapping match (e.g. a JWT inside a generic URL) is simply reported
// under both categories rather than picking one arbitrarily.
export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "private-key",        category: "keys-and-tokens",       regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "aws-access-key",     category: "keys-and-tokens",       regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws-secret-key",     category: "keys-and-tokens",       regex: /\b(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*["']?([A-Za-z0-9\/+=]{40})["']?/gi },
  { name: "google-api-key",     category: "keys-and-tokens",       regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "firebase-url",       category: "urls",                  regex: /\bhttps?:\/\/[a-z0-9-]+\.(?:firebaseio\.com|firebaseapp\.com)\b/gi },
  { name: "slack-token",        category: "keys-and-tokens",       regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: "jwt",                category: "keys-and-tokens",       regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: "basic-auth-header",  category: "credentials",           regex: /\bAuthorization\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/=]{8,}["']?/gi },
  { name: "bearer-token",       category: "keys-and-tokens",       regex: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/g },
  { name: "url-with-credentials", category: "credentials",         regex: /\bhttps?:\/\/[^\/\s:@]+:[^\/\s@]+@[^\/\s"'<>]+/g },
  { name: "url",                category: "urls",                  regex: /\bhttps?:\/\/[^\s"'<>]+/g },
  // Octets bounded to 0-255 (not just \d{1,3}) — an unbounded version matched
  // every 4-dot-separated digit run in the wild, including SVG path
  // coordinates like "5.743.329.446", drowning out real IPs in noise.
  { name: "ipv4-with-optional-port", category: "ips",               regex: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?\b/g },
  { name: "email",              category: "emails",                regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "generic-credential-like", category: "generic-credential-like", regex: /\b(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["']([^"'\s]{4,})["']/gi },
];

export interface SecretMatch {
  pattern: string;
  category: string;
  value: string;
  file: string;
}

/** Run every pattern over one string; caller supplies the source file for attribution. */
export function scanString(text: string, file: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { name, category, regex } of SECRET_PATTERNS) {
    // Each pattern owns a global regex instance; reset lastIndex per call
    // since the same RegExp objects are reused across many scanned strings.
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      matches.push({ pattern: name, category, value: m[0], file });
      if (m[0].length === 0) regex.lastIndex++; // guard against zero-width matches looping forever
    }
  }
  return matches;
}

/**
 * Extract runs of printable characters from a binary buffer, the same idea
 * as unix `strings`. Android resources (resources.arsc) and some dex string
 * pools store text as UTF-16LE, so both a plain-ASCII pass and a UTF-16LE
 * pass are run and merged.
 */
export function extractPrintableStrings(buf: Buffer, minLen = 6): string[] {
  const found: string[] = [];

  // ASCII / UTF-8-compatible pass.
  let run = "";
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable) {
      run += String.fromCharCode(byte);
    } else {
      if (run.length >= minLen) found.push(run);
      run = "";
    }
  }
  if (run.length >= minLen) found.push(run);

  // UTF-16LE pass: printable ASCII code unit followed by a 0x00 high byte.
  run = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    if (hi === 0x00 && lo >= 0x20 && lo <= 0x7e) {
      run += String.fromCharCode(lo);
    } else {
      if (run.length >= minLen) found.push(run);
      run = "";
    }
  }
  if (run.length >= minLen) found.push(run);

  return found;
}

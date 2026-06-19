/**
 * Pure logging core (no I/O). Mirrors src/settings.ts / src/git-info.ts: testable
 * primitives the host logger (electron/logger.ts) composes around a file sink. The
 * host is the sole disk writer; nothing here touches the filesystem or process.env.
 */

/** Ordered from least to most verbose; `off` silences everything. */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LogRecord = {
  ts: number;
  level: Exclude<LogLevel, 'off'>;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
};

// Rank by verbosity. A message passes the gate when its rank ≤ the current level's
// rank (and the current level isn't `off`). `off` is rank 0 so it never admits anything.
const RANK: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/**
 * Ordering gate run BEFORE any formatting/serialization (so a suppressed firehose
 * `trace` costs ~nothing). `off` admits nothing; otherwise admit `msg` iff it is no
 * more verbose than `current`.
 */
export function levelEnabled(current: LogLevel, msg: Exclude<LogLevel, 'off'>): boolean {
  if (current === 'off') return false;
  return RANK[msg] <= RANK[current];
}

/** One JSONL record per line — no trailing newline (the sink owns line termination). */
export function formatRecord(r: LogRecord): string {
  return JSON.stringify(r);
}

// Substring patterns (case-insensitive) that mark a value as sensitive. `key` catches
// api_key / apikey / *_KEY; `env` catches a wholesale env dump (never serialized).
const SENSITIVE = [
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'key',
  'env',
];

const REDACTED = '[redacted]';

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE.some((p) => k.includes(p));
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
  }
  return out;
}

/**
 * Deep-mask values whose key matches a known-sensitive pattern, to `'[redacted]'`.
 * Recurses through nested objects and arrays. Non-mutating: returns a fresh structure
 * (paths/repo data pass through untouched). Always runs before a record reaches a sink.
 */
export function redact(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  return redactObject(data);
}

/** True once the active file's byte count reaches the cap → the sink should roll. */
export function shouldRotate(bytesWritten: number, cap: number): boolean {
  return bytesWritten >= cap;
}

/**
 * Given a set of log filenames, return the ones to DELETE so only the `keep` newest
 * remain. Ordering contract: lexicographic ascending = oldest→newest (filenames are
 * `conduit-YYYYMMDD[-N].log`, so lexicographic order matches chronological order).
 * Sorts defensively, so an unsorted input is fine. Pure — the caller does the unlink.
 */
export function pruneOldLogs(files: string[], keep: number): string[] {
  if (keep <= 0) return [...files].sort();
  const sorted = [...files].sort();
  const excess = sorted.length - keep;
  return excess > 0 ? sorted.slice(0, excess) : [];
}

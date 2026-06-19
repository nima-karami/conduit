export interface PersistedScrollback {
  version: 1;
  sessionId: string;
  // Raw terminal output bytes as a UTF-8 string, ANSI sequences intact, already trimmed
  // to the size cap (newest-wins). This is exactly what gets written back into xterm via
  // term.write() on restore.
  data: string;
}

// 256 KiB trailing window per session: bytes (not lines) because the stream is raw ANSI
// with no reliable line boundaries without parsing. Bounds memory + disk deterministically.
export const SCROLLBACK_CAP_BYTES = 256 * 1024;

/**
 * Append `chunk` to the running scrollback string, keeping at most the trailing `cap`
 * characters (newest-wins). A single chunk larger than `cap` is itself truncated to its
 * trailing `cap` chars — the newest bytes are always kept. Front truncation may slice
 * mid-ANSI-sequence; xterm tolerates a leading partial sequence (it sits at the very top
 * of restored history, before the `— restored —` marker pushes it up). Pure; no I/O.
 */
export function appendScrollback(prev: string, chunk: string, cap: number): string {
  const combined = prev + chunk;
  if (combined.length <= cap) return combined;
  return combined.slice(combined.length - cap);
}

/**
 * Newlines to emit AFTER replaying restored scrollback and BEFORE the PTY starts, so
 * the restored history survives ConPTY's spawn.
 *
 * On Windows, ConPTY's first output is `ESC[2J ESC[H` plus an absolute repaint of the
 * viewport. xterm's ED2 erases the viewport in place (it does not push it to scrollback),
 * so any restored history sitting in the viewport is wiped — the user sees it flash, then
 * a fresh shell. Emitting a full screen of newlines first scrolls the history up into the
 * scrollback buffer, which ConPTY's viewport-relative cursor can't reach; the banner then
 * paints over the now-blank viewport, directly beneath the preserved history.
 *
 * Win32 only: other PTYs don't clear on spawn, so this padding would leave a visible blank
 * gap above the first prompt. Returns '' off-Windows or when `rows` is unknown (<= 0).
 */
export function scrollbackReplayPadding(platform: NodeJS.Platform, rows: number): string {
  if (platform !== 'win32' || rows <= 0) return '';
  return '\r\n'.repeat(rows);
}

export function serializeScrollback(p: PersistedScrollback): string {
  return JSON.stringify(p);
}

export function restoreScrollback(blob: string | undefined): PersistedScrollback | null {
  if (!blob) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<PersistedScrollback>;
  if (p.version !== 1 || typeof p.sessionId !== 'string' || typeof p.data !== 'string') return null;
  return { version: 1, sessionId: p.sessionId, data: p.data };
}

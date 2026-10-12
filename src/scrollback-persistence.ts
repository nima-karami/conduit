import type { ReplayRun, TermGeometry } from './protocol';

/**
 * A run of raw PTY output (UTF-8 string, ANSI intact) and the PTY size it was addressed at.
 * ConPTY paints absolutely, so bytes are only meaningful at their own size. No geometry: a v1
 * file, or an invalid size on disk — replayed at the pane's size, as before v2.
 */
export interface ScrollbackSegment {
  data: string;
  geometry?: TermGeometry;
}

/** A session's scrollback ring: oldest segment first, trimmed to the cap (newest-wins). */
export type ScrollbackRing = ScrollbackSegment[];

export interface PersistedScrollback {
  version: 2;
  sessionId: string;
  segments: ScrollbackRing;
}

// Far beyond any real pane; only here so a corrupt file can't ask xterm for a huge buffer.
const MAX_GEOMETRY = 2000;

function validGeometry(cols: unknown, rows: unknown): TermGeometry | undefined {
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_GEOMETRY;
  return ok(cols) && ok(rows) ? { cols, rows } : undefined;
}

// 256 KiB trailing window per session: bytes (not lines) because the stream is raw ANSI
// with no reliable line boundaries without parsing. Bounds memory + disk deterministically.
export const SCROLLBACK_CAP_BYTES = 256 * 1024;

const sameGeometry = (a?: TermGeometry, b?: TermGeometry) =>
  a === b || (!!a && !!b && a.cols === b.cols && a.rows === b.rows);

/**
 * Append `chunk`, recorded at `geometry`, to the ring: onto the last segment when the size is
 * unchanged, else as a new segment. Then trim from the head across segments to `cap` chars; a
 * partly trimmed head segment keeps its geometry (same mid-sequence tolerance as
 * `appendScrollback`). Pure — returns a new ring.
 */
export function appendToRing(
  ring: ScrollbackRing,
  chunk: string,
  geometry: TermGeometry | undefined,
  cap: number,
): ScrollbackRing {
  const last = ring[ring.length - 1];
  const next =
    last && sameGeometry(last.geometry, geometry)
      ? [...ring.slice(0, -1), { ...last, data: last.data + chunk }]
      : [...ring, geometry ? { data: chunk, geometry } : { data: chunk }];
  let excess = next.reduce((n, s) => n + s.data.length, 0) - cap;
  while (excess > 0) {
    const head = next[0];
    if (head.data.length <= excess) {
      next.shift();
      excess -= head.data.length;
    } else {
      next[0] = { ...head, data: head.data.slice(excess) };
      excess = 0;
    }
  }
  return next;
}

/**
 * Append `chunk` to the running scrollback string, keeping at most the trailing `cap`
 * characters (newest-wins). A single chunk larger than `cap` is itself truncated to its
 * trailing `cap` chars — the newest bytes are always kept. Front truncation may slice
 * mid-ANSI-sequence; xterm tolerates a leading partial sequence at the very top of restored
 * history. Pure; no I/O.
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

/**
 * Emulator-mode resets appended AFTER replayed scrollback on a cold relaunch, so a freshly
 * spawned shell doesn't inherit modes a dead TUI left set in the replayed history.
 *
 * Suffix, not prefix — it has to win over whatever the history sets. `?1049l` sits before the
 * DECSTBM/SGR resets so those land on the normal buffer.
 *
 * Framed in DECSC/DECRC because two of the resets MOVE the cursor: xterm runs DECRC for
 * `?1049l` even outside the alternate screen, and DECSTBM homes it. Unframed, everything written
 * next lands on row 1 over the history. SGR goes after the DECRC, which would otherwise restore
 * the history's last attributes.
 *
 * See docs/specs/archive/2026-08-20-scrollback-replay-neutralizer.md (incl. why the attach path is
 * deliberately exempt).
 */
export const REPLAY_MODE_NEUTRALIZER =
  '\x1b7\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?1049l\x1b[?2004l\x1b[?1l\x1b[?7h\x1b[r\x1b8\x1b[m';

// Ends the replay on a fresh line: xterm never reflows the cursor's row (reflowCursorLine), so
// the fit back to the pane would cut the dead session's last line to the pane's width.
const REPLAY_TAIL = `${REPLAY_MODE_NEUTRALIZER}\r\n`;
const RELAUNCH_LINE = '\x1b[2m— session relaunched —\x1b[0m\r\n';
export const RELAUNCH_MARKER = `\r\n${RELAUNCH_LINE}`;

export interface ColdReplay {
  data: string;
  runs: ReplayRun[];
  /** The bytes the replay adds after the ring, at the last run's size; the ring must record them. */
  tail?: ScrollbackSegment;
}

/** The ring as one string plus the runs that say which size each segment is written at. */
function replayOf(ring: ScrollbackRing, tail = ''): { data: string; runs: ReplayRun[] } {
  const segments = ring.filter((s) => s.data);
  const texts = segments.map((s, i) => (i === segments.length - 1 ? s.data + tail : s.data));
  return {
    data: texts.join(''),
    runs: segments.map((s, i) =>
      s.geometry ? { length: texts[i].length, geometry: s.geometry } : { length: texts[i].length },
    ),
  };
}

/**
 * What a cold start writes before the new child exists: the history, then the neutralizer and a
 * newline. The replay is exactly the ring plus `tail`, so once the host records `tail` a later
 * replay shows what this one did. There is no "restored" marker: every ring segment opens with
 * ConPTY's spawn clear, which would erase it; the relaunch marker in `spawnPrelude` marks the
 * boundary.
 */
export function coldReplay(ring: ScrollbackRing): ColdReplay {
  const replay = replayOf(ring, REPLAY_TAIL);
  if (!replay.data) return { data: '', runs: [] };
  const lastGeometry = ring.filter((s) => s.data).at(-1)?.geometry;
  const tail: ScrollbackSegment = lastGeometry
    ? { data: REPLAY_TAIL, geometry: lastGeometry }
    : { data: REPLAY_TAIL };
  return { ...replay, tail };
}

/**
 * What a pane attaching to a LIVE child is sent: the ring as it is, run by run — no neutralizer,
 * marker or pad, since the child's modes are real and its stream has no break here.
 */
export function attachReplay(ring: ScrollbackRing): { data: string; runs: ReplayRun[] } {
  return replayOf(ring);
}

/**
 * What a cold start writes right after spawning — in the same tick, so it precedes the child's
 * first output: the relaunch marker, then (when history was replayed) the padding that lifts
 * that history clear of ConPTY's spawn clear. A replay always gets the marker — the new child
 * under old history is a relaunch whichever way it started — and needs no leading newline, as
 * the replay already ended on a fresh line. The pad covers the taller of the pane and the
 * history's last recorded size: a pane hidden when the replay ends can't fit back, and stays at
 * the recorded size.
 */
export function spawnPrelude(
  platform: NodeJS.Platform,
  rows: number,
  opts: { relaunched: boolean; replayed: boolean; recordedRows?: number },
): string {
  if (!opts.replayed) return opts.relaunched ? RELAUNCH_MARKER : '';
  const padRows = Math.max(rows, opts.recordedRows ?? 0);
  return RELAUNCH_LINE + scrollbackReplayPadding(platform, padRows);
}

/** On disk a segment is `{cols, rows, data}`, or `{data}` when its size is unknown. */
export function serializeScrollback(p: PersistedScrollback): string {
  return JSON.stringify({
    version: p.version,
    sessionId: p.sessionId,
    segments: p.segments.map((s) =>
      s.geometry ? { ...s.geometry, data: s.data } : { data: s.data },
    ),
  });
}

function restoreSegments(raw: unknown): ScrollbackRing | null {
  if (!Array.isArray(raw)) return null;
  const ring: ScrollbackRing = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const { data, cols, rows } = s as { data?: unknown; cols?: unknown; rows?: unknown };
    if (typeof data !== 'string') return null;
    const geometry = validGeometry(cols, rows);
    ring.push(geometry ? { data, geometry } : { data });
  }
  return ring;
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
  const p = parsed as {
    version?: unknown;
    sessionId?: unknown;
    data?: unknown;
    segments?: unknown;
  };
  if (typeof p.sessionId !== 'string') return null;
  if (p.version === 1) {
    return typeof p.data === 'string'
      ? { version: 2, sessionId: p.sessionId, segments: [{ data: p.data }] }
      : null;
  }
  if (p.version !== 2) return null;
  const segments = restoreSegments(p.segments);
  return segments ? { version: 2, sessionId: p.sessionId, segments } : null;
}

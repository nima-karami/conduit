/**
 * The timed-message model (spec 2026-08-28-timed-messages §2 "The schedule"). Node-free on
 * purpose: the HOST owns userData/timed-messages.json and the scheduler with it, and the
 * RENDERER renders the chip, the dialog and the countdown from it — so the two sides can only
 * ever disagree by disagreeing with this file. Same role src/review-marks.ts plays for marks.
 */

export type TimedMessageKind = 'once' | 'interval';
export type TimedMessageState = 'armed' | 'waiting' | 'done';
export type TimedMessageOrigin = 'manual' | 'limit';
/** Why a due fire produced no delivery. */
export type FireFailure = 'expired' | 'noSession';

/** The wall-clock intent behind an `At` schedule. Sole consumer: Renew (§2 "Triggers"). */
export interface ClockSpec {
  clock: string;
  zone?: string;
}

export interface LastFire {
  at: number;
  late: boolean;
  delivered: boolean;
  reason?: FireFailure;
}

export interface TimedMessage {
  /** `tm-<base36>-<rand>` — the src/review-notes.ts id convention. */
  id: string;
  sessionId: string;
  /** Sanitized, single line. */
  message: string;
  kind: TimedMessageKind;
  /** Epoch ms UTC — authoritative, recomputed after each fire. */
  nextAt: number;
  everyMs?: number;
  spec?: ClockSpec;
  maxRepeats: number;
  firedCount: number;
  state: TimedMessageState;
  /** When it came due with no live PTY — drives the Waiting signal and the toast copy. */
  waitingSince?: number;
  origin: TimedMessageOrigin;
  createdAt: number;
  lastFire?: LastFire;
}

export interface TimedMessagesFile {
  version: 1;
  schedules: TimedMessage[];
}

/** What the composer submits. `nextAt` is deliberately absent: the host derives it (§3). */
export type TriggerInput =
  | { kind: 'in'; delayMs: number }
  | { kind: 'at'; clock: string; zone?: string }
  | { kind: 'every'; everyMs: number; maxRepeats: number };

export interface TimedMessageInput {
  id?: string;
  sessionId: string;
  message: string;
  trigger: TriggerInput;
  origin?: TimedMessageOrigin;
}

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_PER_SESSION = 3;
export const MAX_TOTAL = 20;
export const MIN_DELAY_MS = 30_000;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_REPEATS = 100;
export const DEFAULT_REPEATS = 5;
export const DEFAULT_DELAY_MS = 30 * 60_000;
/** Backward grace on an `At` time, so "11:10pm" typed at 11:11pm means now, not tomorrow. */
export const CLOCK_GRACE_MS = 120_000;
export const MAX_CLOCK_AHEAD_MS = 25 * 3_600_000;
export const HOUR_MS = 3_600_000;
/** How stale an intent may be when it finally becomes deliverable — the two decay differently. */
export const CATCHUP_MS: Record<TimedMessageOrigin, number> = {
  manual: 6 * HOUR_MS,
  limit: 24 * HOUR_MS,
};
/** Past this much overdue a fire is reported as late. An on-time fire is always a few ms out. */
export const LATE_GRACE_MS = 30_000;
/** Reset boundaries are approximate, so an auto-resume aims just past one (§5). */
export const LIMIT_PADDING_MS = 60_000;
/** The ONLY message the app composes for itself — never anything parsed from output (§2). */
export const LIMIT_MESSAGE = 'Continue';
/** A message written into a shell that has not printed its prompt yet is lost (§2). */
export const PTY_SETTLE_MS = 3_000;
/** Two writes, not one: a TUI coalescing a single read keeps a trailing CR as literal text. */
export const SUBMIT_GAP_MS = 120;

/**
 * One line, no control characters. This is what makes "always press Enter" safe to specify
 * (§2 "Delivery"): the payload cannot submit early or inject an escape sequence.
 */
export function sanitizeMessage(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d) {
      out += ' ';
      continue;
    }
    if (c < 0x20 || c === 0x7f) continue; // C0 + DEL, ESC included
    if (c >= 0x80 && c <= 0x9f) continue; // C1
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS).trimEnd();
}

export function newTimedMessageId(
  now: number = Date.now(),
  rand: () => number = Math.random,
): string {
  return `tm-${now.toString(36)}-${rand().toString(36).slice(2, 8)}`;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

const ZONE_OPTS: Intl.DateTimeFormatOptions = {
  // h23 rather than hour12:false — the latter still yields '24' for midnight on older ICU.
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * A formatter pinned to `zone`, or null when the runtime rejects the id. An abbreviation like
 * `EDT` is exactly that case, and §2 says it falls back to local rather than failing.
 */
function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const hit = FORMATTERS.get(zone);
  if (hit) return hit;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...ZONE_OPTS });
    fmt.format(0);
    FORMATTERS.set(zone, fmt);
    return fmt;
  } catch {
    return null;
  }
}

/** UTC is the last resort rather than `Date`'s own offset: CI runs on ubuntu and the answer must
 *  never move with the machine's TZ (CLAUDE.md). */
const UTC_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...ZONE_OPTS });

function localFormatter(): Intl.DateTimeFormat {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (local ? zoneFormatter(local) : null) ?? UTC_FORMATTER;
}

function wallClockIn(fmt: Intl.DateTimeFormat, at: number): Wall {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(at))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** The zone's UTC offset in ms at `at` (local minus UTC), read through Intl — never Date's. */
function offsetAt(fmt: Intl.DateTimeFormat, at: number): number {
  const w = wallClockIn(fmt, at);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000;
}

/**
 * The first instant on the far side of an offset transition that `lo`..`hi` straddles.
 * Bisected to the minute, which is where every real transition sits.
 */
function transitionBetween(fmt: Intl.DateTimeFormat, lo: number, hi: number): number {
  const before = offsetAt(fmt, lo);
  let low = lo;
  let high = hi;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 2 / 60_000) * 60_000;
    if (mid === low) break;
    if (offsetAt(fmt, mid) === before) low = mid;
    else high = mid;
  }
  return high;
}

/**
 * The UTC instant for a wall clock in a zone, converged in two passes. A fall-back ambiguity
 * settles on the EARLIER instant (the first pass already agrees with itself there); a
 * spring-forward gap — where neither pass agrees — answers with the instant the clock jumps to.
 */
function instantFor(
  fmt: Intl.DateTimeFormat,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  const o1 = offsetAt(fmt, target);
  const t1 = target - o1;
  const o2 = offsetAt(fmt, t1);
  if (o2 === o1) return t1;
  const t2 = target - o2;
  if (offsetAt(fmt, t2) === o2) return t2;
  return transitionBetween(fmt, Math.min(t1, t2), Math.max(t1, t2));
}

/**
 * The next occurrence of a `HH:MM` wall clock in `zone` (absent or unusable → the machine's),
 * with CLOCK_GRACE_MS of backward tolerance. Null when the clock string is unreadable — a
 * total function here would arm a schedule at a time nobody asked for.
 */
export function resolveClockTime(
  clock: string,
  zone: string | undefined,
  now: number,
): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const fmt = (zone ? zoneFormatter(zone) : null) ?? localFormatter();
  const today = wallClockIn(fmt, now);
  for (let add = 0; add <= 2; add++) {
    const t = instantFor(fmt, today.y, today.mo, today.d + add, h, mi);
    if (t >= now - CLOCK_GRACE_MS) return Math.min(t, now + MAX_CLOCK_AHEAD_MS);
  }
  return null;
}

export function nextFireAt(trigger: TriggerInput, now: number): number | null {
  if (trigger.kind === 'at') return resolveClockTime(trigger.clock, trigger.zone, now);
  if (trigger.kind === 'in') return now + trigger.delayMs;
  return now + trigger.everyMs;
}

export type BuildResult = { ok: true; schedule: TimedMessage } | { ok: false; error: string };

/**
 * Validate a submitted trigger and turn it into a record. Runs on the HOST as well as in the
 * composer, because the renderer is not trusted (§3) — in particular `nextAt` is derived here
 * and never accepted from the wire. `minDelayMs`/`minIntervalMs` drop to 0 under CONDUIT_E2E.
 */
export function buildSchedule(
  input: TimedMessageInput,
  now: number,
  opts: {
    minDelayMs?: number;
    minIntervalMs?: number;
    id?: string;
    newId?: () => string;
  } = {},
): BuildResult {
  const message = sanitizeMessage(input.message);
  if (!message) return { ok: false, error: 'Type a message to send.' };

  const minDelay = opts.minDelayMs ?? MIN_DELAY_MS;
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const t = input.trigger;

  if (t.kind === 'in' && !(t.delayMs >= minDelay)) {
    return { ok: false, error: `Wait at least ${Math.round(minDelay / 1000)} seconds.` };
  }
  if (t.kind === 'every') {
    if (!(t.everyMs >= minInterval)) {
      return { ok: false, error: 'Repeat no faster than once a minute.' };
    }
    if (!Number.isInteger(t.maxRepeats) || t.maxRepeats < 1 || t.maxRepeats > MAX_REPEATS) {
      return { ok: false, error: `Repeats must be between 1 and ${MAX_REPEATS}.` };
    }
  }

  const nextAt = nextFireAt(t, now);
  if (nextAt === null) return { ok: false, error: 'That time could not be read — use HH:MM.' };

  return {
    ok: true,
    schedule: {
      id: opts.id ?? input.id ?? (opts.newId ?? newTimedMessageId)(),
      sessionId: input.sessionId,
      message,
      kind: t.kind === 'every' ? 'interval' : 'once',
      nextAt,
      ...(t.kind === 'every' ? { everyMs: t.everyMs } : {}),
      ...(t.kind === 'at' ? { spec: { clock: t.clock, ...(t.zone ? { zone: t.zone } : {}) } } : {}),
      maxRepeats: t.kind === 'every' ? t.maxRepeats : 1,
      firedCount: 0,
      state: 'armed',
      origin: input.origin ?? 'manual',
      createdAt: now,
    },
  };
}

/** The cap message for arming another schedule, or null when there is room. `editingId` is
 *  excluded so re-saving the third schedule on a session is not refused as a fourth. */
export function capError(
  existing: readonly TimedMessage[],
  sessionId: string,
  editingId: string | undefined,
): string | null {
  const live = existing.filter((s) => s.state !== 'done' && s.id !== editingId);
  if (live.length >= MAX_TOTAL) {
    return `${MAX_TOTAL} timed messages already armed — cancel one first.`;
  }
  if (live.filter((s) => s.sessionId === sessionId).length >= MAX_PER_SESSION) {
    return `${MAX_PER_SESSION} timed messages already on this session — cancel one first.`;
  }
  return null;
}

export interface DueDecision {
  action: 'wait' | 'fire' | 'skip';
  late: boolean;
  /** Interval slots this fire consumes — several collapse into ONE delivery (§2). */
  slots: number;
  overdueMs: number;
}

/**
 * What to do with a schedule at `now`. Applied at the moment it becomes deliverable, which for
 * a `waiting` schedule is when its PTY comes back — that is why the window is measured here
 * and not when it first came due (§4).
 */
export function catchUp(s: TimedMessage, now: number): DueDecision {
  const overdueMs = now - s.nextAt;
  const remaining = Math.max(s.maxRepeats - s.firedCount, 0);
  if (s.state === 'done' || remaining === 0 || overdueMs < 0) {
    return { action: 'wait', late: false, slots: 0, overdueMs };
  }
  const every = s.kind === 'interval' ? Math.max(s.everyMs ?? MIN_INTERVAL_MS, 1) : 0;
  const elapsed = every > 0 ? 1 + Math.floor(overdueMs / every) : 1;
  const slots = Math.min(elapsed, remaining);
  if (overdueMs > CATCHUP_MS[s.origin]) return { action: 'skip', late: true, slots, overdueMs };
  return { action: 'fire', late: overdueMs > LATE_GRACE_MS, slots, overdueMs };
}

/** A schedule that just fired or was renewed is no longer waiting on anything. */
function withoutWaiting(s: TimedMessage): TimedMessage {
  if (s.waitingSince === undefined) return s;
  const next = { ...s };
  delete next.waitingSince;
  return next;
}

export function advanceAfterFire(
  s: TimedMessage,
  now: number,
  outcome: { slots: number; late: boolean; delivered: boolean; reason?: FireFailure },
): TimedMessage {
  const firedCount = Math.min(s.firedCount + outcome.slots, s.maxRepeats);
  const done = firedCount >= s.maxRepeats;
  const every = s.everyMs ?? 0;
  return {
    ...withoutWaiting(s),
    firedCount,
    state: done ? 'done' : 'armed',
    // `slots` is 1 + the elapsed intervals, so the new nextAt is always in the future.
    nextAt: done || s.kind === 'once' ? s.nextAt : s.nextAt + outcome.slots * every,
    lastFire: {
      at: now,
      late: outcome.late,
      delivered: outcome.delivered,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    },
  };
}

/** Came due with no live PTY. `nextAt` is HELD — nothing was delivered (§2 "Lifecycle"). */
export function markWaiting(s: TimedMessage, at: number): TimedMessage {
  return s.state === 'waiting' ? s : { ...s, state: 'waiting', waitingSince: at };
}

/**
 * Restart with the same parameters. An `At` schedule re-resolves its stored WALL CLOCK through
 * Intl rather than adding a fixed offset — the one thing `spec` exists for (§2 "Triggers").
 */
export function renew(s: TimedMessage, now: number): TimedMessage | null {
  const trigger: TriggerInput =
    s.kind === 'interval'
      ? { kind: 'every', everyMs: s.everyMs ?? MIN_INTERVAL_MS, maxRepeats: s.maxRepeats }
      : s.spec
        ? { kind: 'at', clock: s.spec.clock, ...(s.spec.zone ? { zone: s.spec.zone } : {}) }
        : { kind: 'in', delayMs: Math.max(s.nextAt - s.createdAt, 0) };
  const nextAt = nextFireAt(trigger, now);
  if (nextAt === null) return null;
  return { ...withoutWaiting(s), nextAt, firedCount: 0, state: 'armed' };
}

/** English short forms (§10): `45s`, `4m`, `2h 12m`, `1d`. No i18n layer in this repo. */
export function formatDuration(ms: number): string {
  const secs = Math.max(Math.round(ms / 1000), 0);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The chip's and the row's one line. `formatTime` is injected because the real one is an
 * Intl.DateTimeFormat in the user's locale (§10) — which is precisely what a CI-portable test
 * cannot assert against.
 */
export function describeNext(
  s: TimedMessage,
  now: number,
  formatTime: (at: number) => string,
): string {
  if (s.state === 'done') return `Sent ${s.firedCount} of ${s.maxRepeats}`;
  if (s.state === 'waiting') return 'Waiting';
  const delta = s.nextAt - now;
  if (delta <= 0) return 'due now';
  return delta < HOUR_MS ? `in ${formatDuration(delta)}` : `at ${formatTime(s.nextAt)}`;
}

/** Not exported: `fallow:check` fails on an export nothing outside this file consumes. */
function emptyTimedMessagesFile(): TimedMessagesFile {
  return { version: 1, schedules: [] };
}

const isSchedule = (v: unknown): v is TimedMessage => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.sessionId === 'string' &&
    typeof s.message === 'string' &&
    (s.kind === 'once' || s.kind === 'interval') &&
    typeof s.nextAt === 'number' &&
    Number.isFinite(s.nextAt) &&
    typeof s.maxRepeats === 'number' &&
    typeof s.firedCount === 'number' &&
    (s.state === 'armed' || s.state === 'waiting' || s.state === 'done') &&
    (s.origin === 'manual' || s.origin === 'limit') &&
    typeof s.createdAt === 'number'
  );
};

/** A corrupt or foreign-version file is an EMPTY set, never an error: the next write replaces
 *  it and the user loses an armed timer they can see is gone, not their work (§3). */
export function parseTimedMessagesFile(blob: string | undefined): TimedMessagesFile {
  if (!blob) return emptyTimedMessagesFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyTimedMessagesFile();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return emptyTimedMessagesFile();
  }
  const { version, schedules } = parsed as { version?: unknown; schedules?: unknown };
  if (version !== 1 || !Array.isArray(schedules)) return emptyTimedMessagesFile();
  return { version: 1, schedules: schedules.filter(isSchedule).slice(0, MAX_TOTAL) };
}

/** `done` schedules stay listed for the rest of the run so Renew is reachable, but they are
 *  not written — the next launch has nothing to renew (§2 "After a fire"). */
export function serializeTimedMessagesFile(file: TimedMessagesFile): string {
  return JSON.stringify(
    { version: 1, schedules: file.schedules.filter((s) => s.state !== 'done') },
    null,
    2,
  );
}

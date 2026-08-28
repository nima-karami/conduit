/**
 * Usage-limit notice detection (spec 2026-08-28-timed-messages §2 "Limit-aware"). Pure and
 * node-free: the host runs it beside countBareBells on the session's TRAILING output, and the
 * renderer never runs it at all.
 *
 * Best-effort by construction — anchors rather than a fixed string, the tail rather than the
 * stream, and no parseable time means no action at all (§12.8).
 */

import { resolveClockTime } from './timed-messages';

/** Deep enough for a footer under a status line, shallow enough that scrolled-past text never
 *  matches. The caller passes exactly this many lines; nothing here re-reads the stream. */
export const TAIL_LINES = 3;

/** How long a dismissed offer stays dismissed for the same reset time (§2 "Limit-aware"). */
export const OFFER_SUPPRESS_MS = 30 * 60_000;

export interface LimitNotice {
  /** The reset instant, epoch ms UTC. */
  resetAt: number;
  /** The 24-hour wall clock it was read as — kept for the toast copy and the chip. */
  clock: string;
  zone?: string;
  /** The matching line, verbatim. Shown in the offer banner; NEVER used as a message (§2). */
  line: string;
}

/** Host memory, per session. Never persisted: it describes a live moment (§2). */
export interface LimitEpisode {
  resetAt: number;
  resolved: boolean;
  /** When this episode was last acted on — the offer suppression clock. */
  at: number;
}

export type LimitMode = 'off' | 'offer' | 'arm';
export type LimitAction = 'ignore' | 'arm' | 'offer';

const LIMIT_WORD = /\blimits?\b/i;
/** One of these must appear, so "the limit resets nightly" is not a session asking for help. */
const LIMIT_ANCHOR = /\b(hit|reached|exceeded|usage)\b|\bsession limit\b/i;
const RESET_ANCHOR = /\bresets?\b/i;

/** `11:10pm`, `11pm`, `11:10 PM`, `7:05 a.m.` */
const TWELVE_HOUR = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?\b/i;
/** `23:10` */
const TWENTY_FOUR_HOUR = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
/** A parenthesised IANA id — at least one slash, which is what excludes `(EDT)`. */
const IANA_ZONE = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The reset wall clock in a line, normalised to 24-hour `HH:MM`, plus its zone when the line
 * names one. Null when nothing readable is there — which is the whole "degrade, never
 * misfire" rule.
 */
export function parseResetClock(line: string): { clock: string; zone?: string } | null {
  const zoneMatch = IANA_ZONE.exec(line);
  const zone = zoneMatch?.[1];

  const twelve = TWELVE_HOUR.exec(line);
  if (twelve) {
    const raw = Number(twelve[1]);
    if (raw < 1 || raw > 12) return null;
    const pm = twelve[3].toLowerCase() === 'p';
    const hour = pm ? (raw === 12 ? 12 : raw + 12) : raw === 12 ? 0 : raw;
    return { clock: `${pad(hour)}:${twelve[2] ?? '00'}`, ...(zone ? { zone } : {}) };
  }

  const twentyFour = TWENTY_FOUR_HOUR.exec(line);
  if (twentyFour) {
    return { clock: `${pad(Number(twentyFour[1]))}:${twentyFour[2]}`, ...(zone ? { zone } : {}) };
  }
  return null;
}

/**
 * The three anchors, without the time. Its ONE consumer is the host's debug log: a notice whose
 * time did not parse is silence plus a single log line, never a guess (§4).
 */
export function looksLikeLimitLine(line: string): boolean {
  return LIMIT_WORD.test(line) && LIMIT_ANCHOR.test(line) && RESET_ANCHOR.test(line);
}

/**
 * The most recent limit notice in the session's trailing output, or null. All three anchors
 * must hold AND a time must parse; the newest line wins, because a TUI redrawing its footer
 * puts the current state last.
 */
export function scanLimitNotice(tail: readonly string[], now: number): LimitNotice | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!looksLikeLimitLine(line)) continue;
    const parsed = parseResetClock(line);
    if (!parsed) continue;
    const resetAt = resolveClockTime(parsed.clock, parsed.zone, now);
    if (resetAt === null) continue;
    return { resetAt, clock: parsed.clock, ...(parsed.zone ? { zone: parsed.zone } : {}), line };
  }
  return null;
}

/**
 * What a fresh notice should do given what the host already knows about this session's episode.
 * Resolved once, in the host, so two windows produce one schedule and one toast (§2, §4).
 */
export function decideLimitAction(
  prev: LimitEpisode | undefined,
  notice: LimitNotice,
  mode: LimitMode,
  now: number,
): LimitAction {
  if (mode === 'off') return 'ignore';
  if (prev && prev.resetAt === notice.resetAt) {
    // Same episode. A TUI redraws its footer constantly, and an Undo/Dismiss is a decision.
    if (mode === 'arm') return 'ignore';
    if (!prev.resolved) return 'ignore';
    return now - prev.at >= OFFER_SUPPRESS_MS ? 'offer' : 'ignore';
  }
  return mode === 'arm' ? 'arm' : 'offer';
}

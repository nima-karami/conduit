import { type SessionStateFields, sessionIconState } from './session-icon';

/**
 * Sessions in the "needs you" state, in list order. One derivation shared by the session
 * cards and the topbar's aggregate chip, so the count can never disagree with the rail.
 *
 * Pure. Generic in the element type so callers keep their own richer session object.
 */
export function attentionSessions<T extends SessionStateFields>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => sessionIconState(s) === 'attention');
}

/**
 * Copy for the topbar's aggregate chip. Identical in every theme — Neon uppercases it
 * through --label-case rather than saying something else (conductor decision D14).
 * Returns null at zero: the chip is suppressed entirely, never shown as "0 need you".
 */
export function attentionChipLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 needs you' : `${count} need you`;
}

/**
 * How long Snooze silences one session (conductor decision D16). "Not now", not "handled":
 * the agent is still waiting, so the state returns when the window closes.
 */
export const SNOOZE_MS = 10 * 60 * 1000;

/** Snoozed session id → the epoch-ms instant its silence ends. */
export type SnoozeMap = ReadonlyMap<string, number>;

/**
 * Suppress `needsAttention` on sessions inside a live snooze window. Applied ONCE, above
 * both the rail and the topbar chip, so the two can't disagree about who is waiting.
 *
 * Nothing is sent to the host: Snooze must never answer or kill the prompt, so the host
 * keeps its flag and the state re-raises the moment the window lapses. Pure.
 */
export function applySnooze<T extends { id: string; needsAttention?: boolean }>(
  sessions: readonly T[],
  snoozed: SnoozeMap,
  now: number,
): T[] {
  if (snoozed.size === 0) return [...sessions];
  return sessions.map((s) => {
    const until = snoozed.get(s.id);
    return s.needsAttention && until !== undefined && until > now
      ? { ...s, needsAttention: false }
      : s;
  });
}

/**
 * Drop lapsed entries. Returns the SAME map when nothing expired, so a caller holding it
 * in state can skip the re-render (and stop its timer once the map empties).
 */
export function pruneSnoozed(snoozed: SnoozeMap, now: number): SnoozeMap {
  const live = [...snoozed].filter(([, until]) => until > now);
  return live.length === snoozed.size ? snoozed : new Map(live);
}

/** The next instant a snooze lapses, or undefined when none is live — one timer, no polling. */
export function nextSnoozeExpiry(snoozed: SnoozeMap): number | undefined {
  let earliest: number | undefined;
  for (const until of snoozed.values()) {
    if (earliest === undefined || until < earliest) earliest = until;
  }
  return earliest;
}

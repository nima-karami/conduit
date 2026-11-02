import type { Session } from './types';

/**
 * Return the ids of sessions that are stale (their PTY is gone after a restart).
 * Drives "close all stale" — closing a can't-start session stays allowed. Pure — no I/O.
 */
export function staleSessionIds(sessions: Session[]): string[] {
  return sessions.filter((s) => s.status === 'stale').map((s) => s.id);
}

/** A homeMissing session never spawns, so no relaunch affordance offers it (mf-live-edits §2.6). */
export function canRelaunch(s: Pick<Session, 'status' | 'homeMissing'>): boolean {
  return s.status !== 'running' && !s.homeMissing;
}

/** Drives "relaunch all stale" and autoRelaunchStale. */
export function relaunchableSessionIds(sessions: Session[]): string[] {
  return sessions.filter((s) => s.status === 'stale' && !s.homeMissing).map((s) => s.id);
}

/**
 * The startup autoRelaunchStale pass, decided once. Undefined until the host's sessions come from
 * the server: before its first snapshot `sessions` is empty because nothing is known yet.
 */
export function autoRelaunchTargets(
  state: { sessionsLoaded: boolean; sessions: Session[] },
  autoRelaunchStale: boolean,
): string[] | undefined {
  if (!state.sessionsLoaded) return undefined;
  return autoRelaunchStale ? relaunchableSessionIds(state.sessions) : [];
}

import type { Session } from './types';

/**
 * Return the ids of sessions that are stale (their PTY is gone after a restart).
 * Drives both "relaunch all stale" and "close all stale". Pure — no I/O.
 */
export function staleSessionIds(sessions: Session[]): string[] {
  return sessions.filter((s) => s.status === 'stale').map((s) => s.id);
}

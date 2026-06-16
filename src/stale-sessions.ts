import type { Session } from './types';

/**
 * Return the ids of sessions that are stale (their PTY is gone after a restart).
 * Pure helper — unit-testable with no I/O.
 */
export function staleRelaunchTargets(sessions: Session[]): string[] {
  return sessions.filter((s) => s.status === 'stale').map((s) => s.id);
}

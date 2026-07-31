import { sessionIconState } from './session-icon';
import type { Session } from './types';

/** The fields the attention state is derived from — the same trio `sessionIconState` reads. */
type AttentionFields = Pick<Session, 'status' | 'busy' | 'needsAttention'>;

/**
 * Sessions in the "needs you" state, in list order. One derivation shared by the session
 * cards and the topbar's aggregate chip, so the count can never disagree with the rail.
 *
 * Pure. Generic in the element type so callers keep their own richer session object.
 */
export function attentionSessions<T extends AttentionFields>(sessions: readonly T[]): T[] {
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

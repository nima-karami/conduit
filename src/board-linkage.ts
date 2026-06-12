// Pure linkage-state mapping between feature-board cards and agent sessions (N2).
// A session links to a card by carrying that card's id in `Session.cardId`. These
// helpers derive, from the live session list, which sessions belong to a card and
// the single status badge a card should render. No I/O, no React — unit-tested.
import type { Session } from './types';

/** Badge status shown on a card. `running` if any linked session is live, else `exited`. */
export type BadgeStatus = 'running' | 'exited';

export interface CardBadge {
  /** Aggregate status: running if any linked session runs, otherwise exited. */
  status: BadgeStatus;
  /** The session the badge jumps to when clicked (a running one is preferred). */
  sessionId: string;
  /** How many sessions link to the card (drives a small count when > 1). */
  count: number;
}

/** All sessions linked to `cardId`, in list order. A session with no cardId never matches. */
export function sessionsForCard(sessions: Session[], cardId: string): Session[] {
  return sessions.filter((s) => s.cardId === cardId);
}

/**
 * Derive the card's badge from the live session list, or null when nothing links.
 * A running linked session makes the badge `running` and the badge jumps to the
 * most-recently-active running session; otherwise the badge is `exited` (stale counts
 * as not-running) and points at the most-recently-active linked session.
 */
export function badgeStateForCard(sessions: Session[], cardId: string): CardBadge | null {
  const linked = sessionsForCard(sessions, cardId);
  if (linked.length === 0) return null;
  const running = linked.filter((s) => s.status === 'running');
  const mostRecent = (arr: Session[]): Session =>
    arr.reduce((best, s) => (s.lastActiveAt > best.lastActiveAt ? s : best));
  if (running.length > 0) {
    return { status: 'running', sessionId: mostRecent(running).id, count: linked.length };
  }
  return { status: 'exited', sessionId: mostRecent(linked).id, count: linked.length };
}

// Pure derivations of a feature-board card's state from things that live OUTSIDE the
// board document: the live session list (N2) and the pending agent proposal (N1).
// No I/O, no React — unit-tested.
import { type BoardCard, STAGES, type Stage } from './board';
import type { BoardDiff } from './conduit-proposal';
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

// ---- Agent-proposed flag (N1) ----------------------------------------------

/** Which facet of the pending proposal touches a card. */
export type ProposedChange = 'added' | 'moved' | 'edited' | 'removed';

export interface ProposedFlag {
  /** Every facet that names this card, in diff order. A card can be moved AND edited. */
  changes: ProposedChange[];
  /** One line naming what the agent wants, for the flag's tooltip. */
  detail: string;
}

const stageLabel = (stage: Stage): string => STAGES.find((s) => s.id === stage)?.label ?? stage;

/**
 * The "Agent proposed" flag for every card named by the pending proposal, keyed by card id.
 *
 * There is no `proposed` field on a card and there must not be one: a proposal is a whole
 * separate document (`.conduit/board.proposed.json`, ADR 0002 §3) that the human accepts or
 * rejects as a unit. So the flag is exactly "this card differs between the canonical board
 * and the pending proposal" — added, moved, edited or removed — and it clears by itself the
 * moment the proposal is accepted or rejected, because the diff does.
 *
 * `null` (no proposal pending) yields an empty map, so callers need no separate branch.
 */
export function proposedFlags(diff: BoardDiff | null): Map<string, ProposedFlag> {
  const flags = new Map<string, ProposedFlag>();
  const note = (id: string, change: ProposedChange, detail: string) => {
    const existing = flags.get(id);
    if (existing) {
      existing.changes.push(change);
      existing.detail = `${existing.detail} · ${detail}`;
      return;
    }
    flags.set(id, { changes: [change], detail });
  };
  if (!diff) return flags;
  for (const c of diff.added) note(c.id, 'added', `new card in ${stageLabel(c.stage)}`);
  for (const m of diff.moved) note(m.id, 'moved', `move to ${stageLabel(m.to)}`);
  for (const e of diff.edited) note(e.id, 'edited', `edit ${e.fields.join(', ')}`);
  for (const c of diff.removed) note(c.id, 'removed', 'remove this card');
  return flags;
}

/**
 * Cards a pending proposal would ADD to `stage`. They are not on the board yet, so the
 * column renders them after its real cards as read-only previews — the alternative is a
 * proposal whose additions are invisible exactly where the human is looking at the columns.
 */
export function proposedAdditionsIn(diff: BoardDiff | null, stage: Stage): BoardCard[] {
  return diff ? diff.added.filter((c) => c.stage === stage) : [];
}

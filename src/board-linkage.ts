// Pure derivations of a feature-board card's state from things that live OUTSIDE the
// board document: the sessions linked to a card (its rows) and the pending agent proposal (N1).
// No I/O, no React — unit-tested.
import { type BoardCard, STAGES, type Stage } from './board';
import type { BoardDiff } from './conduit-proposal';
import { folderKey } from './folder-key';
import { type NewSessionPrefill, projectForNewSession } from './new-session-seed';
import { sessionHasFolderKey } from './session-folders';
import type { AgentDefinition, Project, Session } from './types';

// ---- Linked sessions (spec 2026-09-23-mf-board §3.2–3.3) -------------------

export type LinkedRowState = 'running' | 'stopped';

/** Sessions linked to `cardId` on the board at `boardHome` — a card id is only unique per
 *  board, so the home-or-root check stops false links across boards (D2, D13). Input order. */
export function linkedSessionsForCard(
  sessions: readonly Session[],
  cardId: string,
  boardHome: string | undefined,
): Session[] {
  if (!boardHome) return [];
  const key = folderKey(boardHome);
  return sessions.filter((s) => s.cardId === cardId && sessionHasFolderKey(s, key));
}

export function linkedRowState(s: Pick<Session, 'status'>): LinkedRowState {
  return s.status === 'running' ? 'running' : 'stopped';
}

/** The most recently active linked session; the first wins a tie. */
export function lastLinkedSession(linked: readonly Session[]): Session | undefined {
  return linked.reduce<Session | undefined>(
    (best, s) => (best && best.lastActiveAt >= s.lastActiveAt ? best : s),
    undefined,
  );
}

export function linkedRowName(s: Pick<Session, 'name'>): string {
  return s.name.trim() || 'Untitled session';
}

export function linkedRowLabel(s: Pick<Session, 'name' | 'status'>, agentLabel: string): string {
  const state = linkedRowState(s) === 'running' ? 'running' : 'not running';
  return `${linkedRowName(s)}, ${agentLabel}, ${state}`;
}

export interface CardPrefillContext {
  sessions: readonly Session[];
  active: Session | undefined;
  projects: readonly Project[];
  agents: readonly Pick<AgentDefinition, 'id'>[];
}

/** New session prefill for a card; null with no board home. Missing roots are kept for the
 *  dialog to show Not found (L11). projectId is always set, so the dialog never derives it. */
export function cardSessionPrefill(
  card: Pick<BoardCard, 'id' | 'title'>,
  ctx: CardPrefillContext,
): NewSessionPrefill | null {
  const { active } = ctx;
  if (!active?.home) return null;
  const last = lastLinkedSession(linkedSessionsForCard(ctx.sessions, card.id, active.home));
  const source = last ?? active;
  const agentId = last && ctx.agents.some((a) => a.id === last.agentId) ? last.agentId : undefined;
  return {
    home: source.home,
    roots: [...source.roots],
    projectId: projectForNewSession(source, ctx.projects),
    cardId: card.id,
    cardTitle: card.title,
    ...(agentId !== undefined ? { agentId } : {}),
  };
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

import type { AttentionReason, Session } from './types';

/**
 * The sidebar's per-agent status, window UI state and renderer runtime
 * (docs/specs/2026-11-02-sidebar-agent-tree.md §3–§4). Pure.
 */

/** 'blocked' is the Needs you state; the copy lives with the UI. */
export type AgentState = 'blocked' | 'done' | 'working' | 'idle' | 'stopped';
export type AgentGroup = 'pinned' | AgentState;
export type SpaceSelection =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'space'; projectId: string };

export interface SidebarUiState {
  selection: SpaceSelection;
  foldedGroups: AgentGroup[];
  foldedSessions: string[];
  pinnedIds: string[];
}

/** Renderer-only and never persisted: a reload re-baselines (spec §4). */
export interface AgentRuntime {
  seen: Readonly<Record<string, number>>;
  stateSince: Readonly<Record<string, number>>;
}

const GROUPS: readonly AgentGroup[] = ['pinned', 'blocked', 'done', 'working', 'idle', 'stopped'];
const MAX_IDS = 10_000;

export function defaultSidebarUi(): SidebarUiState {
  return {
    selection: { kind: 'all' },
    foldedGroups: ['stopped'],
    foldedSessions: [],
    pinnedIds: [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseSelection(v: unknown): SpaceSelection {
  if (!isRecord(v)) return { kind: 'all' };
  if (v.kind === 'none') return { kind: 'none' };
  if (v.kind === 'space' && typeof v.projectId === 'string' && v.projectId !== '')
    return { kind: 'space', projectId: v.projectId };
  return { kind: 'all' };
}

function uniqueCapped<T>(v: unknown[], keep: (x: unknown) => x is T): T[] {
  const out = new Set<T>();
  for (const x of v) {
    if (out.size >= MAX_IDS) break;
    if (keep(x)) out.add(x);
  }
  return [...out];
}

const isId = (x: unknown): x is string => typeof x === 'string' && x !== '';
const isGroup = (x: unknown): x is AgentGroup => GROUPS.includes(x as AgentGroup);

/** Tolerant per field: a bad field takes its default, the rest survive. */
export function parseSidebarUi(value: unknown): SidebarUiState {
  const d = defaultSidebarUi();
  if (!isRecord(value)) return d;
  return {
    selection: parseSelection(value.selection),
    foldedGroups: Array.isArray(value.foldedGroups)
      ? uniqueCapped(value.foldedGroups, isGroup)
      : d.foldedGroups,
    foldedSessions: Array.isArray(value.foldedSessions)
      ? uniqueCapped(value.foldedSessions, isId)
      : d.foldedSessions,
    pinnedIds: Array.isArray(value.pinnedIds) ? uniqueCapped(value.pinnedIds, isId) : d.pinnedIds,
  };
}

/** The app compatibility boundary for the server facts: an old or odd value reads as null/0. */
function completionsOf(s: Pick<Session, 'completions'>): number {
  const c = s.completions;
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 ? c : 0;
}

function reasonOf(s: Pick<Session, 'attentionReason'>): AttentionReason {
  return s.attentionReason === 'blocked' || s.attentionReason === 'bell' ? s.attentionReason : null;
}

/** Spec §4 "Own row status"; legacy needsAttention/completedRun and repo dirtiness play no part. */
export function agentOwnState(session: Session, seen: number, hasAsk: boolean): AgentState {
  if (session.status !== 'running') return 'stopped';
  if (reasonOf(session) !== null || hasAsk) return 'blocked';
  if (session.busy) return 'working';
  if (completionsOf(session) > seen) return 'done';
  return 'idle';
}

function initialSince(s: Session, now: number): number {
  return Number.isFinite(s.lastActiveAt) ? Math.min(s.lastActiveAt, now) : now;
}

function sameRecord(a: Readonly<Record<string, number>>, b: Record<string, number>): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k]);
}

/**
 * One step of the renderer runtime: seen baselines on first sight and clamps to a counter that
 * fell, only the strictly viewed terminal advances it, and stateSince moves only when the own
 * derived state does (spec §4 invariants). No run-end inference: completions are the server's.
 */
export function advanceAgentRuntime(input: {
  previous: AgentRuntime | null;
  before: readonly Session[];
  sessions: readonly Session[];
  previousAskSessionIds: ReadonlySet<string>;
  askSessionIds: ReadonlySet<string>;
  viewedTerminalIds: ReadonlySet<string>;
  now: number;
}): AgentRuntime {
  const { previous, now } = input;
  const beforeById = new Map(input.before.map((s) => [s.id, s]));
  const seen: Record<string, number> = {};
  const stateSince: Record<string, number> = {};
  for (const s of input.sessions) {
    const count = completionsOf(s);
    const prevSeen = previous?.seen[s.id];
    let next = prevSeen === undefined ? count : Math.min(prevSeen, count);
    if (input.viewedTerminalIds.has(s.id)) next = count;
    seen[s.id] = next;
    const prevSince = previous?.stateSince[s.id];
    const was = beforeById.get(s.id);
    if (prevSince === undefined || prevSeen === undefined || !was) {
      stateSince[s.id] = prevSince ?? initialSince(s, now);
      continue;
    }
    const before = agentOwnState(was, prevSeen, input.previousAskSessionIds.has(s.id));
    const after = agentOwnState(s, next, input.askSessionIds.has(s.id));
    stateSince[s.id] = before === after ? prevSince : now;
  }
  if (previous && sameRecord(previous.seen, seen) && sameRecord(previous.stateSince, stateSince))
    return previous;
  return { seen, stateSince };
}

/** Spec §4 "Age"; a future instant clamps to zero. */
export function formatStateAge(stateSince: number, now: number): string {
  const ms = Math.max(0, now - stateSince);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Spec §3: the implicit sidebar New agent's Space; explicit launch contexts never ask this. */
export function defaultNewAgentProject(
  selection: SpaceSelection,
  sessions: readonly Session[],
  lastFocusedId: string | undefined,
): string | null {
  if (selection.kind === 'space') return selection.projectId;
  if (selection.kind === 'none') return null;
  return sessions.find((s) => s.id === lastFocusedId)?.projectId ?? null;
}

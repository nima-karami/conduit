import type { ResolvedSessionIcon } from './session-icon';
import type { Session } from './types';

/**
 * The Agents and Spaces panels' view options (sort, group, filter): their types, defaults,
 * tolerant parsing and the pure Spaces ordering. The defaults reproduce the sidebar as it was
 * before the ⋯ menu existed. Persisted as app settings, so every window shares them.
 */

export type AgentSort = 'recent' | 'name' | 'status' | 'created';
export type AgentGrouping = 'status' | 'space' | 'type' | 'none';
/** The agent family a row's icon belongs to; `other` is every glyph without its own entry. */
export type AgentKind = 'claude' | 'codex' | 'cursor' | 'other';

export interface AgentsView {
  sort: AgentSort;
  group: AgentGrouping;
  runningOnly: boolean;
  needsYou: boolean;
  /** Empty = every kind. */
  kinds: AgentKind[];
}

export const AGENT_SORTS: readonly AgentSort[] = ['recent', 'name', 'status', 'created'];
export const AGENT_GROUPINGS: readonly AgentGrouping[] = ['status', 'space', 'type', 'none'];
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'cursor', 'other'];

export const DEFAULT_AGENTS_VIEW: AgentsView = {
  sort: 'recent',
  group: 'status',
  runningOnly: false,
  needsYou: false,
  kinds: [],
};

export type SpacesSort = 'manual' | 'name' | 'recent';

export interface SpacesView {
  sort: SpacesSort;
  hideEmpty: boolean;
}

export const SPACES_SORTS: readonly SpacesSort[] = ['manual', 'name', 'recent'];

export const DEFAULT_SPACES_VIEW: SpacesView = { sort: 'manual', hideEmpty: false };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def;
const flag = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

/** Tolerant per field: a bad field takes its default, the rest survive. */
export function coerceAgentsView(value: unknown): AgentsView {
  const d = DEFAULT_AGENTS_VIEW;
  if (!isRecord(value)) return { ...d, kinds: [] };
  const picked = new Set(
    Array.isArray(value.kinds) ? value.kinds.filter((k) => AGENT_KINDS.includes(k)) : [],
  );
  return {
    sort: oneOf(value.sort, AGENT_SORTS, d.sort),
    group: oneOf(value.group, AGENT_GROUPINGS, d.group),
    runningOnly: flag(value.runningOnly, d.runningOnly),
    needsYou: flag(value.needsYou, d.needsYou),
    // Canonical order, so two equal selections serialise equal.
    kinds: AGENT_KINDS.filter((k) => picked.has(k)),
  };
}

export function coerceSpacesView(value: unknown): SpacesView {
  const d = DEFAULT_SPACES_VIEW;
  if (!isRecord(value)) return { ...d };
  return {
    sort: oneOf(value.sort, SPACES_SORTS, d.sort),
    hideEmpty: flag(value.hideEmpty, d.hideEmpty),
  };
}

export function isDefaultAgentsView(v: AgentsView): boolean {
  const d = DEFAULT_AGENTS_VIEW;
  return (
    v.sort === d.sort &&
    v.group === d.group &&
    v.runningOnly === d.runningOnly &&
    v.needsYou === d.needsYou &&
    v.kinds.length === 0
  );
}

export function isDefaultSpacesView(v: SpacesView): boolean {
  return v.sort === DEFAULT_SPACES_VIEW.sort && v.hideEmpty === DEFAULT_SPACES_VIEW.hideEmpty;
}

/** The options that can hide an agent; sort and group never do. */
export function hasAgentFilters(v: AgentsView): boolean {
  return v.runningOnly || v.needsYou || v.kinds.length > 0;
}

/** Claude, Codex and Cursor have their own chips; a custom icon or any other mark is Other. */
export function agentKindOf(icon: ResolvedSessionIcon): AgentKind {
  if (icon.type !== 'kind') return 'other';
  return icon.kind === 'claude' || icon.kind === 'codex' || icon.kind === 'cursor'
    ? icon.kind
    : 'other';
}

export function toggleKind(kinds: readonly AgentKind[], kind: AgentKind): AgentKind[] {
  const next = new Set(kinds);
  if (!next.delete(kind)) next.add(kind);
  return AGENT_KINDS.filter((k) => next.has(k));
}

/** The Space group keys use the project id; sessions without a Space share the empty id. */
export const spaceGroupKey = (projectId: string | undefined) => `space:${projectId ?? ''}` as const;
export const kindGroupKey = (kind: AgentKind) => `type:${kind}` as const;

/**
 * Orders the Space rows the panel shows. `All` stays first and `No space` last; only the
 * Spaces between move, and the selected one is never hidden (it would strand the selection).
 */
export function viewSpaceRows<
  R extends { key: string; projectId: string | null; name: string; count: number },
>(
  rows: readonly R[],
  view: SpacesView,
  ctx: { sessions: readonly Session[]; selectedKey: string },
): R[] {
  const head = rows.filter((r) => r.key === 'all');
  const tail = rows.filter((r) => r.key === 'no-space');
  let spaces = rows.filter((r) => r.key !== 'all' && r.key !== 'no-space');
  if (view.hideEmpty) spaces = spaces.filter((r) => r.count > 0 || r.key === ctx.selectedKey);
  if (view.sort === 'name') {
    spaces = [...spaces].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  } else if (view.sort === 'recent') {
    const latest = new Map<string, number>();
    for (const s of ctx.sessions) {
      if (s.projectId === undefined || !Number.isFinite(s.lastActiveAt)) continue;
      latest.set(s.projectId, Math.max(latest.get(s.projectId) ?? -Infinity, s.lastActiveAt));
    }
    // A Space with no agents has no activity: it sorts after every active one, in panel order.
    spaces = spaces
      .map((r, i) => ({ r, i, at: latest.get(r.key) ?? -Infinity }))
      .sort((a, b) => (a.at === b.at ? a.i - b.i : b.at - a.at))
      .map((x) => x.r);
  }
  return [...head, ...spaces, ...tail];
}

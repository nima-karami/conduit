import {
  type AgentGroup,
  type AgentRuntime,
  type AgentState,
  agentOwnState,
  type SidebarUiState,
  type SpaceSelection,
} from './sidebar-state';
import type { Project, Session } from './types';

/**
 * The sidebar's agent forest and Space rows (docs/specs/2026-11-02-sidebar-agent-tree.md §3–§5).
 * Pure and iterative throughout: ancestry comes from persisted, possibly malformed records.
 */

export interface AgentTreeRow {
  sessionId: string;
  parentId: string | null;
  depth: number;
  state: AgentState;
  effectiveState: AgentState;
  stateSince: number;
  childIds: string[];
  descendantCount: number;
  childState: AgentState | null;
  folded: boolean;
}
export interface AgentTreeGroup {
  key: AgentGroup;
  rootIds: string[];
  folded: boolean;
}
export interface AgentTreeModel {
  rows: Readonly<Record<string, AgentTreeRow>>;
  groups: AgentTreeGroup[];
  visibleIds: string[];
}

const RANK: Record<AgentState, 0 | 1 | 2 | 3 | 4> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
  stopped: 0,
};
const STATUS_GROUPS: readonly AgentState[] = ['blocked', 'done', 'working', 'idle', 'stopped'];

export function agentStateRank(state: AgentState): 0 | 1 | 2 | 3 | 4 {
  return RANK[state];
}

const maxState = (a: AgentState, b: AgentState): AgentState => (RANK[a] >= RANK[b] ? a : b);
/** A descendant's Done is a nested mark, not something the ancestor needs viewing for (§5). */
const discount = (s: AgentState): AgentState => (s === 'done' ? 'idle' : s);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function inSelection(s: Session, selection: SpaceSelection): boolean {
  if (selection.kind === 'all') return true;
  if (selection.kind === 'none') return s.projectId === undefined;
  return s.projectId === selection.projectId;
}

/** A row the runtime has not seen yet ages from lastActiveAt, never from the future. */
function sinceFallback(s: Session): number {
  const now = Date.now();
  return Number.isFinite(s.lastActiveAt) ? Math.min(s.lastActiveAt, now) : now;
}

/** Without a seen entry the id is baselined, so it can never read as Done. */
function ownState(s: Session, runtime: AgentRuntime, asks: ReadonlySet<string>): AgentState {
  return agentOwnState(s, runtime.seen[s.id] ?? Number.POSITIVE_INFINITY, asks.has(s.id));
}

/** Cuts every cycle at its lexically smallest id, in place. */
function breakCycles(parent: Map<string, string | null>): void {
  const mark = new Map<string, 1 | 2>();
  for (const start of [...parent.keys()].sort(byId)) {
    const path: string[] = [];
    let cur: string | null | undefined = start;
    while (cur != null && !mark.has(cur)) {
      mark.set(cur, 1);
      path.push(cur);
      cur = parent.get(cur);
    }
    if (cur != null && mark.get(cur) === 1) {
      const cycle = path.slice(path.indexOf(cur));
      const cut = cycle.reduce((a, b) => (b < a ? b : a));
      parent.set(cut, null);
    }
    for (const id of path) mark.set(id, 2);
  }
}

export function buildAgentTree(input: {
  sessions: readonly Session[];
  runtime: AgentRuntime;
  ui: SidebarUiState;
  matchingIds: ReadonlySet<string>;
  askSessionIds: ReadonlySet<string>;
}): AgentTreeModel {
  const { runtime, ui } = input;
  const included = input.sessions.filter(
    (s) => inSelection(s, ui.selection) && input.matchingIds.has(s.id),
  );
  const byKey = new Map(included.map((s) => [s.id, s]));
  const pinned = ui.pinnedIds.filter((id) => byKey.has(id));
  const pinnedSet = new Set(pinned);

  const parent = new Map<string, string | null>();
  for (const s of included) {
    const p = s.openedBy?.sessionId;
    parent.set(s.id, p && p !== s.id && byKey.has(p) && !pinnedSet.has(s.id) ? p : null);
  }
  breakCycles(parent);

  const children = new Map<string, string[]>(included.map((s) => [s.id, []]));
  for (const [id, p] of parent) if (p !== null) children.get(p)?.push(id);
  const roots = included.filter((s) => parent.get(s.id) === null).map((s) => s.id);

  const own = new Map(included.map((s) => [s.id, ownState(s, runtime, input.askSessionIds)]));
  const depth = new Map<string, number>();
  const order: string[] = [];
  for (const r of roots) depth.set(r, 0);
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const c of children.get(id) ?? []) {
      depth.set(c, (depth.get(id) ?? 0) + 1);
      queue.push(c);
    }
  }

  const subtreeMax = new Map<string, AgentState>();
  const descMax = new Map<string, AgentState | null>();
  const descCount = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let best: AgentState | null = null;
    let count = 0;
    for (const c of children.get(id) ?? []) {
      const m = subtreeMax.get(c) ?? 'stopped';
      best = best === null ? m : maxState(best, m);
      count += 1 + (descCount.get(c) ?? 0);
    }
    const self = discount(own.get(id) ?? 'stopped');
    subtreeMax.set(id, best === null ? self : maxState(self, best));
    descMax.set(id, best);
    descCount.set(id, count);
  }

  const rows: Record<string, AgentTreeRow> = {};
  for (const id of order) {
    const s = byKey.get(id);
    if (!s) continue;
    const d = depth.get(id) ?? 0;
    const mine = own.get(id) ?? 'stopped';
    const state = d === 0 ? mine : discount(mine);
    const below = descMax.get(id) ?? null;
    const kids = children.get(id) ?? [];
    rows[id] = {
      sessionId: id,
      parentId: parent.get(id) ?? null,
      depth: d,
      state,
      effectiveState: below === null ? state : maxState(state, below),
      stateSince: runtime.stateSince[id] ?? sinceFallback(s),
      childIds: kids,
      descendantCount: descCount.get(id) ?? 0,
      childState: below,
      folded: kids.length > 0 && ui.foldedSessions.includes(id),
    };
  }

  const compare = (a: string, b: string): number => {
    const ra = rows[a];
    const rb = rows[b];
    return (
      RANK[rb.effectiveState] - RANK[ra.effectiveState] ||
      rb.stateSince - ra.stateSince ||
      (byKey.get(a)?.createdAt ?? 0) - (byKey.get(b)?.createdAt ?? 0) ||
      byId(a, b)
    );
  };
  for (const row of Object.values(rows)) row.childIds.sort(compare);

  const folds = new Set(ui.foldedGroups);
  const groups: AgentTreeGroup[] = [];
  if (pinned.length > 0)
    groups.push({ key: 'pinned', rootIds: pinned, folded: folds.has('pinned') });
  for (const key of STATUS_GROUPS) {
    const rootIds = roots
      .filter((id) => !pinnedSet.has(id) && rows[id].effectiveState === key)
      .sort(compare);
    if (rootIds.length > 0) groups.push({ key, rootIds, folded: folds.has(key) });
  }

  const visibleIds: string[] = [];
  for (const g of groups) {
    if (g.folded) continue;
    const stack = [...g.rootIds].reverse();
    while (stack.length > 0) {
      const id = stack.pop() as string;
      visibleIds.push(id);
      const row = rows[id];
      if (!row.folded)
        for (let i = row.childIds.length - 1; i >= 0; i--) stack.push(row.childIds[i]);
    }
  }
  return { rows, groups, visibleIds };
}

export type SpaceHue = 'green' | 'violet' | 'blue' | 'accent' | 'neutral';
export interface SpaceRowModel {
  key: string;
  projectId: string | null;
  name: string;
  letter: string;
  hue: SpaceHue;
  branch: string | null;
  state: AgentState | null;
  count: number;
}

const HUES: readonly SpaceHue[] = ['green', 'violet', 'blue', 'accent'];

/** FNV-1a over the immutable id, so a rename or reorder never repaints a Space (§3). */
function hueOf(projectId: string): SpaceHue {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return HUES[h % HUES.length];
}

function branchOf(s: Session | undefined): string | null {
  const root = s?.activeRepoRoot;
  const git = root === undefined ? undefined : s?.repoGit?.[root];
  return git?.kind === 'branch' && git.branch ? git.branch : null;
}

/** §3: the last focused member, else the most recently active one (ties: creation, then id). */
function branchSource(members: readonly Session[], lastFocusedId: string | undefined) {
  const focused = members.find((s) => s.id === lastFocusedId);
  if (focused) return focused;
  return [...members].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt || a.createdAt - b.createdAt || byId(a.id, b.id),
  )[0];
}

export function buildSpaceRows(input: {
  projects: readonly Project[];
  sessions: readonly Session[];
  runtime: AgentRuntime;
  askSessionIds: ReadonlySet<string>;
  lastFocusedId: string | undefined;
}): SpaceRowModel[] {
  const { sessions, runtime, askSessionIds } = input;
  const stateOf = (members: readonly Session[]): AgentState | null => {
    let best: AgentState | null = null;
    for (const s of members) {
      const st = ownState(s, runtime, askSessionIds);
      best = best === null ? st : maxState(best, st);
    }
    return best;
  };
  const letterOf = (name: string) => (Array.from(name.trim())[0] ?? '').toLocaleUpperCase();
  const rows: SpaceRowModel[] = [
    {
      key: 'all',
      projectId: null,
      name: 'All',
      letter: '',
      hue: 'neutral',
      branch: null,
      state: stateOf(sessions),
      count: sessions.length,
    },
  ];
  for (const p of [...input.projects].sort((a, b) => a.order - b.order || byId(a.id, b.id))) {
    const members = sessions.filter((s) => s.projectId === p.id);
    rows.push({
      key: p.id,
      projectId: p.id,
      name: p.name,
      letter: letterOf(p.name),
      hue: hueOf(p.id),
      branch: branchOf(branchSource(members, input.lastFocusedId)),
      state: stateOf(members),
      count: members.length,
    });
  }
  const loose = sessions.filter((s) => s.projectId === undefined);
  if (loose.length > 0)
    rows.push({
      key: 'no-space',
      projectId: null,
      name: 'No space',
      letter: '',
      hue: 'neutral',
      branch: branchOf(branchSource(loose, input.lastFocusedId)),
      state: stateOf(loose),
      count: loose.length,
    });
  return rows;
}

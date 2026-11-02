import { describe, expect, it } from 'vitest';
import { agentStateRank, buildAgentTree, buildSpaceRows } from '../../src/agent-tree';
import { type AgentRuntime, defaultSidebarUi, type SidebarUiState } from '../../src/sidebar-state';
import type { Project, Session } from '../../src/types';

const S = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  attentionReason: null,
  completions: 0,
  ...over,
});
const child = (id: string, parent: string, over: Partial<Session> = {}) =>
  S(id, { openedBy: { handle: `h-${parent}`, sessionId: parent }, ...over });

const runtimeOf = (
  sessions: readonly Session[],
  over: Partial<AgentRuntime> = {},
): AgentRuntime => ({
  seen: Object.fromEntries(sessions.map((s) => [s.id, 0])),
  stateSince: Object.fromEntries(sessions.map((s) => [s.id, 0])),
  ...over,
});

function tree(
  sessions: Session[],
  o: {
    ui?: Partial<SidebarUiState>;
    runtime?: Partial<AgentRuntime>;
    matching?: string[];
    asks?: string[];
  } = {},
) {
  return buildAgentTree({
    sessions,
    runtime: runtimeOf(sessions, o.runtime),
    ui: { ...defaultSidebarUi(), foldedGroups: [], ...o.ui },
    matchingIds: new Set(o.matching ?? sessions.map((s) => s.id)),
    askSessionIds: new Set(o.asks ?? []),
  });
}

describe('agentStateRank', () => {
  it('orders Needs you > Done > Working > Idle > Stopped', () => {
    expect(
      ['blocked', 'done', 'working', 'idle', 'stopped'].map((s) => agentStateRank(s as never)),
    ).toEqual([4, 3, 2, 1, 0]);
  });
});

describe('buildAgentTree — forest', () => {
  it('nests three levels by openedBy.sessionId', () => {
    const t = tree([S('p'), child('c', 'p'), child('g', 'c')]);
    expect(t.rows.p).toMatchObject({
      parentId: null,
      depth: 0,
      childIds: ['c'],
      descendantCount: 2,
    });
    expect(t.rows.c).toMatchObject({
      parentId: 'p',
      depth: 1,
      childIds: ['g'],
      descendantCount: 1,
    });
    expect(t.rows.g).toMatchObject({ parentId: 'c', depth: 2, childIds: [], descendantCount: 0 });
    expect(t.visibleIds).toEqual(['p', 'c', 'g']);
    expect(t.groups).toEqual([{ key: 'idle', rootIds: ['p'], folded: false }]);
  });

  it('roots a child whose parent is missing, filtered out or in another window', () => {
    const sessions = [
      S('p', { projectId: 'A' }),
      child('c', 'p', { projectId: 'B' }),
      child('o', 'gone'),
    ];
    const all = tree(sessions);
    expect(all.rows.c.parentId).toBe('p');
    expect(all.rows.o.parentId).toBeNull();
    const b = tree(sessions, { ui: { selection: { kind: 'space', projectId: 'B' } } });
    expect(Object.keys(b.rows)).toEqual(['c']);
    expect(b.rows.c).toMatchObject({ parentId: null, depth: 0 });
    const none = tree(sessions, { ui: { selection: { kind: 'none' } } });
    expect(Object.keys(none.rows)).toEqual(['o']);
    const text = tree(sessions, { matching: ['c'] });
    expect(text.rows.c.parentId).toBeNull();
    // Another window's parent is simply not in this window's session list.
    expect(tree([child('c', 'elsewhere')]).rows.c.parentId).toBeNull();
  });

  it('rejects self-parenting and breaks a cycle at its lexically smallest id', () => {
    const self = tree([child('a', 'a')]);
    expect(self.rows.a.parentId).toBeNull();
    const cyc = tree([child('b', 'c'), child('c', 'a'), child('a', 'b')]);
    expect(cyc.rows.a.parentId).toBeNull();
    expect(cyc.rows.c.parentId).toBe('a');
    expect(cyc.rows.b.parentId).toBe('c');
    expect(cyc.visibleIds).toEqual(['a', 'c', 'b']);
    // A tail hanging off a cycle keeps its parent; only the cycle is cut.
    const tail = tree([child('x', 'y'), child('y', 'x'), child('t', 'y')]);
    expect(tail.rows.x.parentId).toBeNull();
    expect(tail.rows.t.parentId).toBe('y');
  });

  it('survives a long malformed chain without recursion', () => {
    const n = 20_000;
    const chain = Array.from({ length: n }, (_, i) =>
      i === 0 ? S('n0') : child(`n${i}`, `n${i - 1}`),
    );
    const t = tree(chain);
    expect(t.visibleIds).toHaveLength(n);
    expect(t.rows[`n${n - 1}`].depth).toBe(n - 1);
    expect(t.rows.n0.descendantCount).toBe(n - 1);
  });
});

describe('buildAgentTree — status', () => {
  it('a blocked grandchild promotes every ancestor, even folded', () => {
    const sessions = [S('p'), child('c', 'p'), child('g', 'c', { attentionReason: 'blocked' })];
    const t = tree(sessions, { ui: { foldedSessions: ['p'] } });
    expect(t.rows.p).toMatchObject({
      state: 'idle',
      effectiveState: 'blocked',
      childState: 'blocked',
      folded: true,
    });
    expect(t.rows.c.effectiveState).toBe('blocked');
    expect(t.groups).toEqual([{ key: 'blocked', rootIds: ['p'], folded: false }]);
    expect(t.visibleIds).toEqual(['p']);
  });

  it('an ask marks its own row Needs you', () => {
    expect(tree([S('a')], { asks: ['a'] }).rows.a.state).toBe('blocked');
  });

  it('a nested Done reads Idle and never promotes an ancestor to Done', () => {
    const sessions = [S('p'), child('c', 'p', { completions: 2 })];
    const t = tree(sessions);
    expect(t.rows.c).toMatchObject({ state: 'idle', effectiveState: 'idle' });
    expect(t.rows.p).toMatchObject({ state: 'idle', effectiveState: 'idle', childState: 'idle' });
    // Detached, the same unseen completion is a Done root.
    expect(tree([child('c', 'gone', { completions: 2 })]).rows.c.state).toBe('done');
  });

  it('a root keeps its own Done', () => {
    const t = tree([S('p', { completions: 1 }), child('c', 'p', { busy: true })]);
    expect(t.rows.p).toMatchObject({
      state: 'done',
      effectiveState: 'done',
      childState: 'working',
    });
    expect(t.groups[0].key).toBe('done');
  });

  it('an unseen id reads as baselined, never Done', () => {
    const sessions = [S('a', { completions: 3 })];
    const t = buildAgentTree({
      sessions,
      runtime: { seen: {}, stateSince: {} },
      ui: defaultSidebarUi(),
      matchingIds: new Set(['a']),
      askSessionIds: new Set(),
    });
    expect(t.rows.a.state).toBe('idle');
  });
});

describe('buildAgentTree — groups, pins and order', () => {
  it('orders groups Pinned, Needs you, Done, Working, Idle, Stopped and hides empty ones', () => {
    const sessions = [
      S('st', { status: 'stale' }),
      S('id'),
      S('wk', { busy: true }),
      S('dn', { completions: 1 }),
      S('bl', { attentionReason: 'bell' }),
      S('pn'),
    ];
    const t = tree(sessions, { ui: { pinnedIds: ['pn'], foldedGroups: ['stopped'] } });
    expect(t.groups.map((g) => [g.key, g.rootIds, g.folded])).toEqual([
      ['pinned', ['pn'], false],
      ['blocked', ['bl'], false],
      ['done', ['dn'], false],
      ['working', ['wk'], false],
      ['idle', ['id'], false],
      ['stopped', ['st'], true],
    ]);
    expect(t.visibleIds).toEqual(['pn', 'bl', 'dn', 'wk', 'id']);
  });

  it('a pinned child roots once in Pinned and keeps its descendants', () => {
    const sessions = [S('p'), child('c', 'p'), child('g', 'c')];
    const t = tree(sessions, { ui: { pinnedIds: ['c'] } });
    expect(t.rows.c).toMatchObject({ parentId: null, depth: 0, childIds: ['g'] });
    expect(t.rows.p.childIds).toEqual([]);
    expect(t.groups).toEqual([
      { key: 'pinned', rootIds: ['c'], folded: false },
      { key: 'idle', rootIds: ['p'], folded: false },
    ]);
    expect(t.visibleIds).toEqual(['c', 'g', 'p']);
    expect(sessions[1].openedBy?.sessionId).toBe('p');
  });

  it('pinned roots keep pin order; others sort by stateSince desc, createdAt asc, id', () => {
    const sessions = [
      S('a', { createdAt: 2 }),
      S('b', { createdAt: 1 }),
      S('c', { createdAt: 1 }),
      S('d'),
      S('e'),
    ];
    const t = tree(sessions, {
      ui: { pinnedIds: ['e', 'd'] },
      runtime: { stateSince: { a: 10, b: 5, c: 5, d: 0, e: 0 } },
    });
    expect(t.groups[0].rootIds).toEqual(['e', 'd']);
    expect(t.groups[1].rootIds).toEqual(['a', 'b', 'c']);
  });

  it('children sort by effective rank first', () => {
    const t = tree([S('p'), child('x', 'p'), child('y', 'p', { busy: true })]);
    expect(t.rows.p.childIds).toEqual(['y', 'x']);
  });

  it('a fold hides descendants from visible order but never changes rank; leaves never fold', () => {
    const t = tree([S('p'), child('c', 'p', { busy: true }), S('leaf')], {
      ui: { foldedSessions: ['p', 'leaf'] },
    });
    expect(t.rows.p).toMatchObject({ folded: true, effectiveState: 'working' });
    expect(t.rows.leaf.folded).toBe(false);
    expect(t.visibleIds).toEqual(['p', 'leaf']);
  });

  it('a folded group drops all its rows from visible order', () => {
    const t = tree([S('a'), S('b', { busy: true })], { ui: { foldedGroups: ['idle'] } });
    expect(t.visibleIds).toEqual(['b']);
  });

  it('keeps an unrelated session age when its ancestor regroups', () => {
    const sessions = [S('p'), child('c', 'p')];
    const t = tree(sessions, { runtime: { stateSince: { p: 1, c: 42 } } });
    expect(t.rows.c.stateSince).toBe(42);
  });
});

describe('buildSpaceRows', () => {
  const projects: Project[] = [
    { id: 'p2', name: 'beta', order: 1 },
    { id: 'p1', name: 'alpha', order: 0 },
    { id: 'p3', name: 'empty', order: 2 },
  ];
  const git = (branch: string) => ({
    repoGit: { '/r': { kind: 'branch' as const, branch } },
    activeRepoRoot: '/r',
  });

  function rows(sessions: Session[], lastFocusedId?: string, asks: string[] = []) {
    return buildSpaceRows({
      projects,
      sessions,
      runtime: runtimeOf(sessions),
      askSessionIds: new Set(asks),
      lastFocusedId,
    });
  }

  it('lists All, every saved Space by order, then No space only with members', () => {
    const r = rows([S('a', { projectId: 'p1' }), S('b', { status: 'stale' })]);
    expect(r.map((x) => [x.key, x.projectId, x.name, x.count])).toEqual([
      ['all', null, 'All', 2],
      ['p1', 'p1', 'alpha', 1],
      ['p2', 'p2', 'beta', 0],
      ['p3', 'p3', 'empty', 0],
      ['no-space', null, 'No space', 1],
    ]);
    expect(rows([S('a', { projectId: 'p1' })]).map((x) => x.key)).not.toContain('no-space');
  });

  it('gives tiles a letter and a stable hue from the project id', () => {
    const r = rows([]);
    expect(r.find((x) => x.key === 'p1')).toMatchObject({ letter: 'A' });
    expect(r.find((x) => x.key === 'all')?.hue).toBe('neutral');
    const renamed = buildSpaceRows({
      projects: [{ id: 'p1', name: 'zzz', order: 9 }],
      sessions: [],
      runtime: { seen: {}, stateSince: {} },
      askSessionIds: new Set(),
      lastFocusedId: undefined,
    });
    expect(renamed.find((x) => x.key === 'p1')?.hue).toBe(r.find((x) => x.key === 'p1')?.hue);
    for (const x of r) expect(['green', 'violet', 'blue', 'accent', 'neutral']).toContain(x.hue);
  });

  it('aggregates the most urgent own state, Done counted even for a displayed child', () => {
    const sessions = [
      S('p', { projectId: 'p1' }),
      child('c', 'p', { projectId: 'p1', completions: 1 }),
      S('q', { projectId: 'p2', busy: true }),
      S('r', { projectId: 'p2' }),
    ];
    const r = rows(sessions, undefined, ['r']);
    expect(r.find((x) => x.key === 'p1')?.state).toBe('done');
    expect(r.find((x) => x.key === 'p2')?.state).toBe('blocked');
    expect(r.find((x) => x.key === 'p3')?.state).toBeNull();
    expect(r.find((x) => x.key === 'all')?.state).toBe('blocked');
  });

  it("takes the branch from the Space's last focused member, else its most recently active", () => {
    const sessions = [
      S('a', { projectId: 'p1', lastActiveAt: 5, ...git('feat') }),
      S('b', { projectId: 'p1', lastActiveAt: 9, ...git('main') }),
      S('c', {
        projectId: 'p2',
        repoGit: { '/r': { kind: 'detached', sha: 'abc1234' } },
        activeRepoRoot: '/r',
      }),
    ];
    expect(rows(sessions, 'a').find((x) => x.key === 'p1')?.branch).toBe('feat');
    expect(rows(sessions, 'zzz').find((x) => x.key === 'p1')?.branch).toBe('main');
    expect(rows(sessions, 'c').find((x) => x.key === 'p2')?.branch).toBeNull();
    expect(rows(sessions).find((x) => x.key === 'all')?.branch).toBeNull();
  });
});

describe('buildAgentTree — age fallback', () => {
  it('a row the runtime has not seen ages from lastActiveAt clamped to now', () => {
    const sessions = [S('past', { lastActiveAt: 5 }), S('future', { lastActiveAt: 9e15 })];
    const before = Date.now();
    const t = buildAgentTree({
      sessions,
      runtime: { seen: {}, stateSince: {} },
      ui: defaultSidebarUi(),
      matchingIds: new Set(['past', 'future']),
      askSessionIds: new Set(),
    });
    expect(t.rows.past.stateSince).toBe(5);
    expect(t.rows.future.stateSince).toBeGreaterThanOrEqual(before);
    expect(t.rows.future.stateSince).toBeLessThanOrEqual(Date.now());
  });
});

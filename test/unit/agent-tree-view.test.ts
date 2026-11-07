import { describe, expect, it } from 'vitest';
import { buildAgentTree } from '../../src/agent-tree';
import { type AgentRuntime, defaultSidebarUi } from '../../src/sidebar-state';
import {
  type AgentKind,
  type AgentsView,
  agentKindOf,
  coerceAgentsView,
  coerceSpacesView,
  DEFAULT_AGENTS_VIEW,
  DEFAULT_SPACES_VIEW,
  hasAgentFilters,
  isDefaultAgentsView,
  isDefaultSpacesView,
  toggleKind,
  viewSpaceRows,
} from '../../src/sidebar-view';
import type { Session } from '../../src/types';

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

/** A mixed forest: every state, a lead with helpers, three Spaces' worth, a pinned root. */
const SESSIONS: Session[] = [
  S('lead', { createdAt: 10, projectId: 'p1' }),
  child('h-busy', 'lead', { busy: true, createdAt: 12, projectId: 'p1' }),
  child('h-ask', 'lead', { attentionReason: 'blocked', createdAt: 11, projectId: 'p1' }),
  S('busy-a', { name: 'Mango', busy: true, createdAt: 21, projectId: 'p2' }),
  S('busy-b', { name: 'Apple', busy: true, createdAt: 20, projectId: 'p1' }),
  S('busy-c', { name: 'Zebra', busy: true, createdAt: 23, projectId: 'p2' }),
  S('idle-a', { createdAt: 30, projectId: 'p2' }),
  S('idle-b', { createdAt: 31 }),
  S('ended', { status: 'exited', createdAt: 40, projectId: 'p1' }),
  S('pin', { createdAt: 50, projectId: 'p2' }),
];
const RUNTIME: AgentRuntime = {
  seen: Object.fromEntries(SESSIONS.map((s) => [s.id, 0])),
  stateSince: {
    lead: 5,
    'h-busy': 9,
    'h-ask': 2,
    'busy-a': 300,
    'busy-b': 200,
    'busy-c': 100,
    'idle-a': 7,
    'idle-b': 7,
    ended: 1,
    pin: 4,
  },
};
const KINDS: Record<string, AgentKind> = {
  lead: 'claude',
  'h-busy': 'codex',
  'h-ask': 'codex',
  'busy-a': 'claude',
  'busy-b': 'cursor',
  'busy-c': 'other',
  'idle-a': 'codex',
  'idle-b': 'other',
  ended: 'claude',
  pin: 'cursor',
};
const ui = { ...defaultSidebarUi(), foldedGroups: [], pinnedIds: ['pin'] };

const build = (view?: Partial<AgentsView>, sessions: Session[] = SESSIONS) =>
  buildAgentTree({
    sessions,
    runtime: RUNTIME,
    ui,
    matchingIds: new Set(sessions.map((s) => s.id)),
    askSessionIds: new Set(),
    ...(view
      ? {
          view: { ...DEFAULT_AGENTS_VIEW, ...view },
          kindOf: (s: Session) => KINDS[s.id] ?? 'other',
          spaces: [{ id: 'p1' }, { id: 'p2' }],
        }
      : {}),
  });
const groupsOf = (t: ReturnType<typeof build>) => t.groups.map((g) => [g.key, g.rootIds]);

describe('the tree before the view menu existed', () => {
  const groups = [
    ['pinned', ['pin']],
    ['blocked', ['lead']],
    ['working', ['busy-a', 'busy-b', 'busy-c']],
    ['idle', ['idle-a', 'idle-b']],
    ['stopped', ['ended']],
  ];
  const visible = [
    'pin',
    'lead',
    'h-ask',
    'h-busy',
    'busy-a',
    'busy-b',
    'busy-c',
    'idle-a',
    'idle-b',
    'ended',
  ];

  it('is the order the sidebar always had when no view is given', () => {
    const t = build();
    expect(groupsOf(t)).toEqual(groups);
    expect(t.visibleIds).toEqual(visible);
  });

  it('is exactly what the default view produces', () => {
    const t = build({});
    expect(groupsOf(t)).toEqual(groups);
    expect(t.visibleIds).toEqual(visible);
    expect(t).toEqual(build());
  });
});

describe('Sort', () => {
  it('Name: case-insensitive by name, helpers too', () => {
    const t = build({ sort: 'name' });
    expect(t.groups.find((g) => g.key === 'working')?.rootIds).toEqual([
      'busy-b',
      'busy-a',
      'busy-c',
    ]);
    expect(t.rows.lead.childIds).toEqual(['h-ask', 'h-busy']);
  });

  it('Created: newest first', () => {
    const t = build({ sort: 'created' });
    expect(t.groups.find((g) => g.key === 'working')?.rootIds).toEqual([
      'busy-c',
      'busy-a',
      'busy-b',
    ]);
    expect(t.groups.find((g) => g.key === 'idle')?.rootIds).toEqual(['idle-b', 'idle-a']);
    expect(t.rows.lead.childIds).toEqual(['h-busy', 'h-ask']);
  });

  it('Status: needs you first, then by name; Name ignores status', () => {
    const roots = (sort: 'status' | 'name') =>
      build({ sort, group: 'none' }).groups.find((g) => g.key === 'flat')?.rootIds;
    expect(roots('status')).toEqual([
      'lead',
      'busy-b',
      'busy-a',
      'busy-c',
      'idle-a',
      'idle-b',
      'ended',
    ]);
    expect(roots('name')).toEqual([
      'busy-b',
      'ended',
      'idle-a',
      'idle-b',
      'lead',
      'busy-a',
      'busy-c',
    ]);
    expect(build({ sort: 'status' }).rows.lead.childIds).toEqual(['h-ask', 'h-busy']);
  });
});

describe('Group', () => {
  it('None: one headerless list, pinned still first, nesting kept', () => {
    const t = build({ group: 'none' });
    expect(t.groups.map((g) => g.key)).toEqual(['pinned', 'flat']);
    expect(t.visibleIds).toEqual([
      'pin',
      'lead',
      'h-ask',
      'h-busy',
      'busy-a',
      'busy-b',
      'busy-c',
      'idle-a',
      'idle-b',
      'ended',
    ]);
  });

  it('By space: one group per Space in panel order, then no space; helpers stay under their lead', () => {
    const t = build({ group: 'space' });
    expect(groupsOf(t)).toEqual([
      ['pinned', ['pin']],
      ['space:p1', ['lead', 'busy-b', 'ended']],
      ['space:p2', ['busy-a', 'busy-c', 'idle-a']],
      ['space:', ['idle-b']],
    ]);
    expect(t.visibleIds.slice(0, 5)).toEqual(['pin', 'lead', 'h-ask', 'h-busy', 'busy-b']);
  });

  it('By space: a root whose Space is not listed joins the no-space group instead of vanishing', () => {
    const orphan = S('orphan', { projectId: 'gone', createdAt: 60 });
    const t = build({ group: 'space' }, [...SESSIONS, orphan]);
    expect(t.groups.find((g) => g.key === 'space:')?.rootIds).toEqual(['idle-b', 'orphan']);
    expect(t.visibleIds).toContain('orphan');
  });

  it('By agent type: Claude, Codex, Cursor, Other; a helper of another kind nests under its lead', () => {
    const t = build({ group: 'type' });
    expect(groupsOf(t)).toEqual([
      ['pinned', ['pin']],
      ['type:claude', ['lead', 'busy-a', 'ended']],
      ['type:codex', ['idle-a']],
      ['type:cursor', ['busy-b']],
      ['type:other', ['busy-c', 'idle-b']],
    ]);
    expect(t.rows['h-busy'].parentId).toBe('lead');
  });

  it('a folded group of any kind hides its rows', () => {
    const t = buildAgentTree({
      sessions: SESSIONS,
      runtime: RUNTIME,
      ui: { ...ui, foldedGroups: ['space:p1'] },
      matchingIds: new Set(SESSIONS.map((s) => s.id)),
      askSessionIds: new Set(),
      view: { ...DEFAULT_AGENTS_VIEW, group: 'space' },
      spaces: [{ id: 'p1' }, { id: 'p2' }],
    });
    expect(t.groups.find((g) => g.key === 'space:p1')?.folded).toBe(true);
    expect(t.visibleIds).not.toContain('lead');
    expect(t.visibleIds).toContain('busy-a');
  });
});

describe('Filter', () => {
  it('Running only drops stopped agents', () => {
    const t = build({ runningOnly: true });
    expect(t.visibleIds).not.toContain('ended');
    expect(t.groups.map((g) => g.key)).not.toContain('stopped');
  });

  it('Needs you keeps agents whose own state is Needs you; a helper left without its lead roots', () => {
    const t = build({ needsYou: true });
    expect(t.visibleIds).toEqual(['h-ask']);
    expect(t.rows['h-ask'].parentId).toBeNull();
  });

  it('agent types are multi-select; none selected is all', () => {
    expect(build({ kinds: ['cursor', 'other'] }).visibleIds.sort()).toEqual(
      ['busy-b', 'busy-c', 'idle-b', 'pin'].sort(),
    );
    expect(build({ kinds: [] }).visibleIds).toHaveLength(SESSIONS.length);
  });

  it('options combine as AND', () => {
    expect(build({ runningOnly: true, kinds: ['claude'] }).visibleIds.sort()).toEqual([
      'busy-a',
      'lead',
    ]);
  });

  it('a filter that hides everything leaves no groups', () => {
    expect(build({ needsYou: true, kinds: ['cursor'] }).groups).toEqual([]);
  });
});

describe('view options', () => {
  it('the default is default and anything else is not', () => {
    expect(isDefaultAgentsView(DEFAULT_AGENTS_VIEW)).toBe(true);
    for (const patch of [
      { sort: 'name' },
      { group: 'none' },
      { runningOnly: true },
      { needsYou: true },
      { kinds: ['codex'] },
    ] as Partial<AgentsView>[])
      expect(isDefaultAgentsView({ ...DEFAULT_AGENTS_VIEW, ...patch })).toBe(false);
  });

  it('only filters count as hiding agents', () => {
    expect(hasAgentFilters({ ...DEFAULT_AGENTS_VIEW, sort: 'name', group: 'type' })).toBe(false);
    expect(hasAgentFilters({ ...DEFAULT_AGENTS_VIEW, kinds: ['codex'] })).toBe(true);
  });

  it('a stored value survives a round trip and a bad one falls back per field', () => {
    const v: AgentsView = {
      sort: 'created',
      group: 'type',
      runningOnly: true,
      needsYou: false,
      kinds: ['codex', 'claude'],
    };
    expect(coerceAgentsView(JSON.parse(JSON.stringify(v)))).toEqual({
      ...v,
      kinds: ['claude', 'codex'],
    });
    expect(
      coerceAgentsView({
        sort: 'sideways',
        group: 'type',
        runningOnly: 'yes',
        kinds: ['x', 'codex'],
      }),
    ).toEqual({ ...DEFAULT_AGENTS_VIEW, group: 'type', kinds: ['codex'] });
    expect(coerceAgentsView(null)).toEqual(DEFAULT_AGENTS_VIEW);
    expect(coerceAgentsView([])).toEqual(DEFAULT_AGENTS_VIEW);
  });

  it('a coerced default never shares the default kinds array', () => {
    const a = coerceAgentsView(undefined);
    a.kinds.push('codex');
    expect(DEFAULT_AGENTS_VIEW.kinds).toEqual([]);
  });

  it('toggleKind adds and removes, keeping chip order', () => {
    expect(toggleKind(['codex'], 'claude')).toEqual(['claude', 'codex']);
    expect(toggleKind(['claude', 'codex'], 'claude')).toEqual(['codex']);
  });

  it('classifies icons: three named families, everything else Other', () => {
    expect(agentKindOf({ type: 'kind', kind: 'claude' })).toBe('claude');
    expect(agentKindOf({ type: 'kind', kind: 'codex' })).toBe('codex');
    expect(agentKindOf({ type: 'kind', kind: 'cursor' })).toBe('cursor');
    for (const kind of ['gemini', 'opencode', 'agent', 'terminal', 'powershell'] as const)
      expect(agentKindOf({ type: 'kind', kind })).toBe('other');
    expect(agentKindOf({ type: 'lucide', name: 'rocket' })).toBe('other');
  });
});

describe('Spaces view', () => {
  const row = (key: string, name: string, count: number) => ({
    key,
    projectId: key === 'all' || key === 'no-space' ? null : key,
    name,
    count,
  });
  const rows = [
    row('all', 'All', 5),
    row('p1', 'Zulu', 2),
    row('p2', 'alpha', 0),
    row('p3', 'Mike', 3),
    row('no-space', 'No space', 1),
  ];
  const keys = (r: { key: string }[]) => r.map((x) => x.key);
  const sessions = [
    S('a', { projectId: 'p1', lastActiveAt: 10 }),
    S('b', { projectId: 'p3', lastActiveAt: 50 }),
  ];
  const at = (view: Parameters<typeof viewSpaceRows>[1], selectedKey = 'all') =>
    keys(viewSpaceRows(rows, view, { sessions, selectedKey }));

  it('the default leaves the panel as it was', () => {
    expect(at(DEFAULT_SPACES_VIEW)).toEqual(keys(rows));
  });

  it('Name sorts the Spaces between All and No space', () => {
    expect(at({ sort: 'name', hideEmpty: false })).toEqual(['all', 'p2', 'p3', 'p1', 'no-space']);
  });

  it('Recent puts the latest activity first and empty Spaces last', () => {
    expect(at({ sort: 'recent', hideEmpty: false })).toEqual(['all', 'p3', 'p1', 'p2', 'no-space']);
  });

  it('Hide empty drops empty Spaces except the selected one', () => {
    const view = { sort: 'manual', hideEmpty: true } as const;
    expect(at(view)).toEqual(['all', 'p1', 'p3', 'no-space']);
    expect(at(view, 'p2')).toContain('p2');
  });

  it('coerces and detects the default', () => {
    expect(coerceSpacesView({ sort: 'bogus', hideEmpty: 1 })).toEqual(DEFAULT_SPACES_VIEW);
    expect(coerceSpacesView({ sort: 'name', hideEmpty: true })).toEqual({
      sort: 'name',
      hideEmpty: true,
    });
    expect(isDefaultSpacesView(DEFAULT_SPACES_VIEW)).toBe(true);
    expect(isDefaultSpacesView({ sort: 'name', hideEmpty: false })).toBe(false);
    expect(isDefaultSpacesView({ sort: 'manual', hideEmpty: true })).toBe(false);
  });
});

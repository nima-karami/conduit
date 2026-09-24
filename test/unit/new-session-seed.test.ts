import { describe, expect, it } from 'vitest';
import type { LauncherDTO } from '../../src/launchers';
import {
  agentForHome,
  projectForNewSession,
  type SeedContext,
  seedNewSession,
} from '../../src/new-session-seed';
import type { RepoDTO } from '../../src/protocol';
import type { AgentDefinition, Project, Session } from '../../src/types';

const agent = (id: string): AgentDefinition => ({
  id,
  label: id,
  command: id,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'shell:pwsh',
  home: `/w/${id}`,
  roots: [],
  status: 'running',
  createdAt: 1,
  lastActiveAt: 1,
  ...over,
});

const projects: Project[] = [
  { id: 'p1', name: 'RMB pipeline', order: 0 },
  { id: 'p2', name: 'Other', order: 1 },
];
const agents = [agent('shell:pwsh'), agent('shell:cmd'), agent('cli:claude'), agent('cli:codex')];
const launchers: LauncherDTO[] = [
  { id: 'shell:pwsh', kind: 'shell', uses: 0 },
  { id: 'shell:cmd', kind: 'shell', uses: 0 },
  { id: 'cli:claude', kind: 'cli', uses: 0 },
  { id: 'cli:codex', kind: 'cli', uses: 0 },
];
const repos: RepoDTO[] = [
  { path: '/w/recent', name: 'recent', lastAgentId: 'cli:codex', lastOpened: 9 },
  { path: '/w/old', name: 'old', lastAgentId: 'gone:agent', lastOpened: 1 },
];

function ctx(over: Partial<SeedContext> = {}): SeedContext {
  return {
    active: undefined,
    sessions: [],
    projects,
    repos,
    agents,
    launchers,
    defaultAgentId: '',
    ...over,
  };
}

describe('seedNewSession', () => {
  it("{} with active in a live project → that project, its most recent session's home+roots", () => {
    const a = session('a', { projectId: 'p1', lastActiveAt: 5 });
    const b = session('b', { projectId: 'p1', lastActiveAt: 9, home: '/w/rmb', roots: ['/w/ci'] });
    const c = session('c', { projectId: 'p2', lastActiveAt: 99 });
    expect(seedNewSession({}, ctx({ active: a, sessions: [a, b, c] }))).toEqual({
      agentId: 'shell:pwsh',
      projectId: 'p1',
      home: '/w/rmb',
      roots: ['/w/ci'],
    });
  });

  it('{} with active standalone → null project, repos[0] home', () => {
    const a = session('a');
    expect(seedNewSession({}, ctx({ active: a, sessions: [a] }))).toEqual({
      agentId: 'cli:codex',
      projectId: null,
      home: '/w/recent',
      roots: [],
    });
  });

  it('{home: dir} (explorer) → project derived from active, home dir, roots []', () => {
    const a = session('a', { projectId: 'p2', roots: ['/w/z'] });
    expect(seedNewSession({ home: '/w/a/pkg' }, ctx({ active: a, sessions: [a] }))).toEqual({
      agentId: 'shell:pwsh',
      projectId: 'p2',
      home: '/w/a/pkg',
      roots: [],
    });
  });

  it('{agentId} (omni-bar) → that agent when registered', () => {
    expect(seedNewSession({ agentId: 'cli:claude' }, ctx()).agentId).toBe('cli:claude');
    expect(seedNewSession({ agentId: 'cli:nope' }, ctx()).agentId).toBe('cli:codex');
  });

  it('board prefill {home, roots, projectId:null, cardId} → standalone, folders as given, missing root kept', () => {
    const a = session('a', { projectId: 'p1' });
    const seed = seedNewSession(
      {
        home: '/w/rmb',
        roots: ['/w/ci', '/w/gone'],
        projectId: null,
        cardId: 'c1',
        cardTitle: 'Move',
      },
      ctx({ active: a, sessions: [a] }),
    );
    expect(seed).toEqual({
      agentId: 'shell:pwsh',
      projectId: null,
      home: '/w/rmb',
      roots: ['/w/ci', '/w/gone'],
    });
  });

  it('dangling prefill projectId → derived', () => {
    const a = session('a', { projectId: 'p2' });
    const c = ctx({ active: a, sessions: [a] });
    expect(seedNewSession({ projectId: 'deleted', home: '/w/x' }, c).projectId).toBe('p2');
    expect(seedNewSession({ projectId: 'p1', home: '/w/x' }, c).projectId).toBe('p1');
  });

  it('roots without home ignored', () => {
    expect(seedNewSession({ roots: ['/w/ci'] }, ctx({ repos: [] }))).toEqual({
      agentId: 'shell:pwsh',
      projectId: null,
      roots: [],
    });
  });

  it('roots dedupe by key and drop home', () => {
    const seed = seedNewSession(
      { home: 'C:/W/Rmb', roots: ['c:/w/rmb/', 'C:/w/ci', 'c:\\w\\CI', 'C:/w/b'] },
      ctx(),
    );
    expect(seed.roots).toEqual(['C:/w/ci', 'C:/w/b']);
  });

  it('agent: prefill → home lastAgentId → defaultAgentId → first shell → agents[0]', () => {
    const c = ctx({ defaultAgentId: 'shell:cmd' });
    expect(seedNewSession({ home: '/w/recent', agentId: 'cli:claude' }, c).agentId).toBe(
      'cli:claude',
    );
    expect(seedNewSession({ home: '/w/recent' }, c).agentId).toBe('cli:codex');
    expect(seedNewSession({ home: '/w/old' }, c).agentId).toBe('shell:cmd');
    expect(seedNewSession({ home: '/w/old' }, ctx({ defaultAgentId: 'gone' })).agentId).toBe(
      'shell:pwsh',
    );
    const noShells = ctx({ launchers: launchers.filter((l) => l.kind !== 'shell') });
    expect(seedNewSession({ home: '/w/old' }, noShells).agentId).toBe('shell:pwsh');
    expect(agentForHome('/w/old', { ...noShells, agents: [agent('cli:claude')] })).toBe(
      'cli:claude',
    );
    expect(agentForHome(undefined, { ...noShells, agents: [] })).toBe('');
  });

  it('a shadowed cli id (D20 alias) seeds the agents.json entry that shadows it (review S7)', () => {
    const shadowed = ctx({
      agents: [agent('shell:pwsh'), agent('my-claude')],
      launchers: [
        { id: 'shell:pwsh', kind: 'shell', uses: 0 },
        { id: 'my-claude', kind: 'config', uses: 0, aliases: ['cli:claude'] },
      ],
      repos: [{ path: '/w/r', name: 'r', lastAgentId: 'cli:claude', lastOpened: 1 }],
    });
    expect(agentForHome('/w/r', shadowed)).toBe('my-claude');
    expect(seedNewSession({ home: '/w/r' }, shadowed).agentId).toBe('my-claude');
    expect(seedNewSession({ home: '/w/x', agentId: 'cli:claude' }, shadowed).agentId).toBe(
      'my-claude',
    );
    expect(agentForHome('/w/x', { ...shadowed, defaultAgentId: 'cli:claude' })).toBe('my-claude');
  });

  it('no folders anywhere → home undefined, roots []', () => {
    expect(seedNewSession({}, ctx({ repos: [] }))).toEqual({
      agentId: 'shell:pwsh',
      projectId: null,
      roots: [],
    });
  });
});

describe('projectForNewSession', () => {
  it('projectForNewSession: live → id; standalone, dangling, no active → null', () => {
    expect(projectForNewSession(session('a', { projectId: 'p1' }), projects)).toBe('p1');
    expect(projectForNewSession(session('a'), projects)).toBeNull();
    expect(projectForNewSession(session('a', { projectId: 'deleted' }), projects)).toBeNull();
    expect(projectForNewSession(undefined, projects)).toBeNull();
  });
});

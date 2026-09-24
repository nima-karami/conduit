import { describe, expect, it } from 'vitest';
import type { LauncherDTO } from '../../src/launchers';
import type { NewSessionSeed, SeedContext } from '../../src/new-session-seed';
import type { LaunchPreviewError, LaunchPreviewResult } from '../../src/protocol';
import type { AgentDefinition, Project } from '../../src/types';
import {
  initialNewSessionState,
  MAX_DIALOG_FOLDERS,
  type NewSessionAction,
  type NewSessionState,
  previewErrorCopy,
  reduceNewSession,
  startBlock,
} from '../../webview/new-session-state';

const agent = (id: string, label = id): AgentDefinition => ({
  id,
  label,
  command: id,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const agents = [agent('shell:pwsh'), agent('cli:claude', 'claude'), agent('cli:codex', 'codex')];
const launchers: LauncherDTO[] = [
  { id: 'shell:pwsh', kind: 'shell', uses: 0 },
  { id: 'cli:claude', kind: 'cli', uses: 0 },
  { id: 'cli:codex', kind: 'cli', uses: 0 },
];
const projects: Project[] = [{ id: 'p1', name: 'RMB pipeline', order: 0 }];

function ctx(over: Partial<SeedContext> = {}): SeedContext {
  return {
    active: undefined,
    sessions: [],
    projects,
    repos: [
      { path: '/w/a', name: 'a', lastAgentId: 'cli:claude', lastOpened: 2 },
      { path: '/w/b', name: 'b', lastAgentId: 'cli:codex', lastOpened: 1 },
    ],
    agents,
    launchers,
    defaultAgentId: '',
    ...over,
  };
}

const seed = (over: Partial<NewSessionSeed> = {}): NewSessionSeed => ({
  agentId: 'shell:pwsh',
  projectId: null,
  roots: [],
  ...over,
});

const run = (s: NewSessionState, ...actions: NewSessionAction[]) =>
  actions.reduce((acc, a) => reduceNewSession(acc, a, ctx()), s);

const view = (result?: LaunchPreviewResult) => ({ result, loading: false });

describe('reduceNewSession', () => {
  it('first folder added becomes home and re-picks the agent', () => {
    const s = run(initialNewSessionState(seed()), { type: 'addFolder', path: '/w/a' });
    expect(s.folders).toEqual(['/w/a']);
    expect(s.agentId).toBe('cli:claude');
    expect(s.announce).toBe('Added a');
  });

  it('after pickAgent, a home change keeps the agent (D13)', () => {
    const s = run(
      initialNewSessionState(seed()),
      { type: 'pickAgent', id: 'cli:codex', fromMore: false },
      { type: 'addFolder', path: '/w/a' },
    );
    expect(s.agentId).toBe('cli:codex');
    expect(s.agentPicked).toBe(true);
  });

  it('a More pick becomes the extra pill; a row pick keeps it', () => {
    const s = run(initialNewSessionState(seed()), {
      type: 'pickAgent',
      id: 'cli:codex',
      fromMore: true,
    });
    expect(s.extraPillId).toBe('cli:codex');
    expect(run(s, { type: 'pickAgent', id: 'cli:claude', fromMore: false }).extraPillId).toBe(
      'cli:codex',
    );
  });

  it('duplicate add flashes the existing row', () => {
    const s = run(initialNewSessionState(seed({ home: 'C:/W/A', roots: ['/w/b'] })), {
      type: 'addFolder',
      path: 'c:\\w\\a\\',
    });
    expect(s.folders).toEqual(['C:/W/A', '/w/b']);
    expect(s.flashKey).toBe('c:/w/a');
    expect(s.hint).toBeUndefined();
  });

  it('inside → Already covered by <name>; contains → Contains <name>', () => {
    const base = initialNewSessionState(seed({ home: '/w/rmb', roots: ['/x/ci'] }));
    const inside = run(base, { type: 'addFolder', path: '/x/ci/sub' });
    expect(inside.hint).toBe('Already covered by ci');
    expect(inside.folders).toEqual(['/w/rmb', '/x/ci']);
    const contains = run(base, { type: 'addFolder', path: '/w' });
    expect(contains.hint).toBe('Contains rmb');
    expect(run(contains, { type: 'addFolder', path: '/q' }).hint).toBeUndefined();
  });

  it('32 folders → add ignored', () => {
    const roots = Array.from({ length: MAX_DIALOG_FOLDERS - 1 }, (_, i) => `/r/${i}`);
    const s = initialNewSessionState(seed({ home: '/h', roots }));
    expect(s.folders).toHaveLength(32);
    expect(run(s, { type: 'addFolder', path: '/new' })).toBe(s);
  });

  it('home × only when it is the only folder', () => {
    const two = initialNewSessionState(seed({ home: '/w/a', roots: ['/w/b'] }));
    expect(run(two, { type: 'removeFolder', path: '/w/a' }).folders).toEqual(['/w/a', '/w/b']);
    const one = run(two, { type: 'removeFolder', path: '/w/b' });
    expect(one.folders).toEqual(['/w/a']);
    expect(one.announce).toBe('Removed b');
    expect(run(one, { type: 'removeFolder', path: '/w/a' }).folders).toEqual([]);
  });

  it('makeHome swaps: [B, A, C]', () => {
    const s = run(initialNewSessionState(seed({ home: '/w/a', roots: ['/w/b', '/w/c'] })), {
      type: 'makeHome',
      path: '/w/b',
    });
    expect(s.folders).toEqual(['/w/b', '/w/a', '/w/c']);
    expect(s.agentId).toBe('cli:codex');
    expect(s.announce).toBe('b is now home');
  });

  it('makeHome on a Not found row refused', () => {
    const s = run(
      initialNewSessionState(seed({ home: '/w/a', roots: ['/w/gone'] })),
      { type: 'probed', results: [{ path: '/w/gone', exists: false }] },
      { type: 'makeHome', path: '/w/gone' },
    );
    expect(s.folders).toEqual(['/w/a', '/w/gone']);
    expect(s.probes['/w/gone']).toEqual({ exists: false });
  });

  it('newProject: blank/81 chars ignored; case-insensitive match selects existing; else pending', () => {
    const s = initialNewSessionState(seed());
    expect(run(s, { type: 'newProject', name: '   ' })).toBe(s);
    expect(run(s, { type: 'newProject', name: 'x'.repeat(81) })).toBe(s);
    const match = run(s, { type: 'newProject', name: '  rmb PIPELINE ' });
    expect(match.projectId).toBe('p1');
    expect(match.pendingProjectName).toBeUndefined();
    const pending = run(s, { type: 'newProject', name: ' Fresh  one ' });
    expect(pending.pendingProjectName).toBe('Fresh one');
    expect(pending.projectId).toBeNull();
    expect(
      run(pending, { type: 'setProject', projectId: 'p1' }).pendingProjectName,
    ).toBeUndefined();
  });

  it('start while starting → unchanged', () => {
    const s = run(initialNewSessionState(seed({ home: '/w/a' })), { type: 'start' });
    expect(s.phase).toBe('starting');
    expect(run(s, { type: 'start' })).toBe(s);
  });

  it('startFailed returns to editing with the copy', () => {
    const s = run(
      initialNewSessionState(seed({ home: '/w/a' })),
      { type: 'start' },
      { type: 'startFailed', reason: 'home folder not found', project: false },
    );
    expect(s.phase).toBe('editing');
    expect(s.startError).toBe("Couldn't start session: home folder not found");
    const p = run(s, { type: 'start' }, { type: 'startFailed', reason: 'x', project: true });
    expect(p.projectError).toBe(true);
  });

  it('revalidate: deleted project → null; unregistered agent → agentForHome', () => {
    const s = initialNewSessionState(seed({ home: '/w/b', agentId: 'cli:gone', projectId: 'p1' }));
    const r = reduceNewSession(s, { type: 'revalidate' }, ctx({ projects: [] }));
    expect(r.projectId).toBeNull();
    expect(r.agentId).toBe('cli:codex');
    const same = initialNewSessionState(seed({ home: '/w/b', projectId: 'p1' }));
    expect(reduceNewSession(same, { type: 'revalidate' }, ctx())).toBe(same);
  });
});

describe('startBlock', () => {
  const ready = initialNewSessionState(
    seed({ home: '/w/a', roots: ['/w/b'], agentId: 'cli:claude' }),
  );

  it('no agents → No terminals found', () => {
    expect(startBlock(ready, view(), [])?.reason).toBe('No terminals found');
  });

  it('no folders → Add a folder to start', () => {
    expect(startBlock(initialNewSessionState(seed()), view(), agents)?.reason).toBe(
      'Add a folder to start',
    );
  });

  it('home missing → Home folder not found', () => {
    const s = run(ready, { type: 'probed', results: [{ path: '/w/a', exists: false }] });
    expect(startBlock(s, view(), agents)?.reason).toBe('Home folder not found');
  });

  it('skipped x&y with claude.cmd → the .cmd shim message naming "x&y" and "&"', () => {
    const result: LaunchPreviewResult = {
      command: 'C:\\npm\\claude.cmd',
      skippedAddDirRoots: ['D:\\work\\x&y'],
    };
    expect(startBlock(ready, view(result), agents)?.reason).toBe(
      'claude is a .cmd shim and can\'t take "x&y" (contains &). Rename the folder or use an .exe install.',
    );
    const bat = { ...result, command: 'C:\\b\\claude.BAT', skippedAddDirRoots: ['/w/100%'] };
    expect(startBlock(ready, view(bat), agents)?.reason).toBe(
      'claude is a .bat shim and can\'t take "100%" (contains %). Rename the folder or use an .exe install.',
    );
  });

  it('unresolvable launcher → blocked with the preview copy (QA F1)', () => {
    const bare = view({ error: 'unresolvable', command: 'claude', skippedAddDirRoots: [] });
    expect(startBlock(ready, bare, agents)?.reason).toBe(
      "Can't resolve claude: claude isn't on PATH",
    );
    const gone = view({
      error: 'unresolvable',
      command: 'C:\\t\\aider.exe',
      skippedAddDirRoots: [],
    });
    expect(startBlock(ready, gone, agents)?.reason).toBe(
      "Can't resolve claude: C:\\t\\aider.exe doesn't exist",
    );
  });

  it('a preview in flight blocks Start, even over a clean stale result (review S4)', () => {
    const stale = { result: { skippedAddDirRoots: [], display: 'claude' }, loading: true };
    expect(startBlock(ready, stale, agents)?.reason).toBe('Checking the command…');
    expect(startBlock(ready, { loading: true }, agents)?.reason).toBe('Checking the command…');
  });

  it('every preview error token maps to user copy, never the raw token (review S6)', () => {
    const tokens: LaunchPreviewError[] = [
      'home-missing',
      'unknown-launcher',
      'unresolvable',
      'invalid-request',
    ];
    for (const error of tokens) {
      const copy = previewErrorCopy({ error, command: 'x', skippedAddDirRoots: [] }, 'claude');
      expect(copy, error).toMatch(/^Can't resolve claude: /);
      expect(copy, error).not.toContain(error);
    }
    expect(previewErrorCopy({ skippedAddDirRoots: [] }, 'claude')).toBeUndefined();
  });

  it('otherwise null', () => {
    expect(startBlock(ready, view({ skippedAddDirRoots: [] }), agents)).toBeNull();
    expect(startBlock(ready, view(), agents)).toBeNull();
  });
});

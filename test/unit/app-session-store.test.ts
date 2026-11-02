import { describe, expect, it } from 'vitest';
import { AppSessionStore } from '../../electron/app-session-store';
import type { SessionView } from '../../src/contracts/server-protocol';
import type { RepoInfo } from '../../src/repo-scan';

const view = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/work/A',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  runtime: { generation: 3, spawn: 'live', reportedStatus: null, lastSize: null },
  ...over,
});

const repos: RepoInfo[] = [
  { root: '/work/A', name: '.', folder: '/work/A', tag: 'home' },
  { root: '/work/A/sub', name: 'sub', folder: '/work/A', tag: 'nested' },
  { root: '/work/B', name: '.', folder: '/work/B', tag: 'attached' },
];
const clean = { kind: 'branch', branch: 'main', dirty: false } as const;

function storeWith(...ids: string[]) {
  const store = new AppSessionStore();
  store.applyServer((ids.length ? ids : ['s1']).map((id) => view(id)));
  const h = { store, calls: 0 };
  store.onChange(() => h.calls++);
  return h;
}

describe('AppSessionStore D39 overlay', () => {
  it('overlay wins over a snapshot carrying repo fields', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    store.pinRepo('s1', '/work/B');
    // A server must never send these; if one does, the app's own derivation still holds.
    const stray: SessionView = Object.assign(view('s1'), {
      activeRepoRoot: '/elsewhere',
      repos: [],
      repoPinned: false,
    });
    store.applyServer([stray]);
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/B');
    expect(store.get('s1')?.repoPinned).toBe(true);
    expect(store.list()[0].repos).toEqual(repos);
    // With no overlay, server-sent repo fields are stripped rather than shown.
    store.applyServer([stray, Object.assign(view('s2'), { activeRepoRoot: '/elsewhere' })]);
    expect(store.get('s2')?.activeRepoRoot).toBeUndefined();
    expect(store.list().find((s) => s.id === 's2')?.activeRepoRoot).toBeUndefined();
  });

  it('vanished session drops overlay', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    store.setRepoGit('s1', { '/work/A': clean });
    const diffs = store.applyServer([]);
    expect(diffs).toEqual([
      { sessionId: 's1', kind: 'removed', homeChanged: false, cwdChanged: false },
    ]);
    expect(store.get('s1')).toBeUndefined();
    store.applyServer([view('s1')]);
    expect(store.get('s1')?.repos).toBeUndefined();
    expect(store.get('s1')?.repoGit).toBeUndefined();
  });

  it('diff flags homeChanged and cwdChanged', () => {
    const store = new AppSessionStore();
    expect(store.applyServer([view('s1', { cwd: '/work/A' }), view('s2')])).toEqual([
      { sessionId: 's1', kind: 'added', homeChanged: true, cwdChanged: true },
      { sessionId: 's2', kind: 'added', homeChanged: true, cwdChanged: false },
    ]);
    expect(store.applyServer([view('s1', { cwd: '/work/A' }), view('s2')])).toEqual([]);
    expect(
      store.applyServer([view('s1', { cwd: '/work/A/sub' }), view('s2', { home: '/work/B' })]),
    ).toEqual([
      { sessionId: 's1', kind: 'changed', homeChanged: false, cwdChanged: true },
      { sessionId: 's2', kind: 'changed', homeChanged: true, cwdChanged: false },
    ]);
    expect(
      store.applyServer([
        view('s1', { cwd: '/work/A/sub', roots: ['/work/B'] }),
        view('s2', { home: '/work/B' }),
      ]),
    ).toEqual([{ sessionId: 's1', kind: 'changed', homeChanged: false, cwdChanged: false }]);
  });

  it('a moved home re-resolves the opened-root fallback', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/A');
    store.applyServer([view('s1', { home: '/work/B' })]);
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/B');
  });

  it('generationOf reads the server runtime; unknown is null', () => {
    const { store } = storeWith();
    expect(store.generationOf('s1')).toBe(3);
    store.applyServer([
      view('s1', {
        runtime: { generation: null, spawn: 'none', reportedStatus: null, lastSize: null },
      }),
    ]);
    expect(store.generationOf('s1')).toBeNull();
    expect(store.generationOf('nope')).toBeNull();
  });
});

describe('AppSessionStore repo state', () => {
  it('derives activeRepoRoot from repos with opened-root fallback', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/A');
    expect(store.get('s1')?.repoPinned).toBe(false);
  });

  it('auto-follow sets the active repo when unpinned', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    store.setAutoRepo('s1', '/work/B');
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/B');
  });

  it('a pin holds the active repo across auto-follow until unpinned', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    store.pinRepo('s1', '/work/A/sub');
    expect(store.get('s1')?.repoPinned).toBe(true);
    store.setAutoRepo('s1', '/work/B');
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/A/sub');
    store.unpinRepo('s1');
    expect(store.get('s1')?.repoPinned).toBe(false);
    expect(store.get('s1')?.activeRepoRoot).toBe('/work/B');
  });

  it('a deleted pinned repo falls back when repos refresh', () => {
    const { store } = storeWith();
    store.setRepos('s1', repos);
    store.pinRepo('s1', '/work/B');
    store.setRepos(
      's1',
      repos.filter((r) => r.root !== '/work/B'),
    );
    expect(store.get('s1')?.activeRepoRoot).not.toBe('/work/B');
    expect(store.get('s1')?.repoPinned).toBe(false);
  });

  it('setRepos emits on a tag-only change', () => {
    const h = storeWith();
    h.store.setRepos('s1', repos);
    h.calls = 0;
    h.store.setRepos('s1', [...repos]);
    expect(h.calls).toBe(0);
    h.store.setRepos('s1', [repos[0], { ...repos[1], tag: 'attached' }, repos[2]]);
    expect(h.calls).toBe(1);
    h.store.setRepos('s1', [
      repos[0],
      { ...repos[1], tag: 'attached' },
      { ...repos[2], folder: '/w' },
    ]);
    expect(h.calls).toBe(2);
  });

  it('setRepos returns true only when it emitted', () => {
    const h = storeWith();
    expect(h.store.setRepos('s1', repos)).toBe(true);
    expect(h.calls).toBe(1);
    expect(h.store.setRepos('s1', [...repos])).toBe(false);
    expect(h.calls).toBe(1);
    expect(h.store.setRepos('missing', repos)).toBe(false);
  });

  it('setRepoGit emits on a per-repo dirty change, not on an equal map', () => {
    const h = storeWith();
    h.store.setRepoGit('s1', { '/work/A': clean, '/work/B': clean });
    expect(h.calls).toBe(1);
    h.store.setRepoGit('s1', { '/work/A': { ...clean }, '/work/B': { ...clean } });
    expect(h.calls).toBe(1);
    h.store.setRepoGit('s1', { '/work/A': clean, '/work/B': { ...clean, dirty: true } });
    expect(h.calls).toBe(2);
    expect(h.store.get('s1')?.repoGit?.['/work/B']?.dirty).toBe(true);
    h.store.setRepoGit('s1', { '/work/A': clean });
    expect(h.calls).toBe(3);
    h.store.setRepoGit('s1', { '/work/A': clean, '/work/C': { kind: 'none' } });
    expect(h.calls).toBe(4);
    h.store.setRepoGit('s1', undefined);
    expect(h.calls).toBe(5);
    expect(h.store.get('s1')?.repoGit).toBeUndefined();
    h.store.setRepoGit('s1', undefined);
    expect(h.calls).toBe(5);
  });

  it('mergeRepoGit patches several sessions with a single emit and skips unchanged', () => {
    const h = storeWith('s1', 's2');
    h.store.setRepoGit('s1', { '/work/A': clean, '/work/X': clean });
    h.calls = 0;
    const before = h.store.get('s1')?.repoGit;
    h.store.mergeRepoGit([
      { sessionId: 's1', root: '/work/A', info: { ...clean, dirty: true } },
      { sessionId: 's2', root: '/work/B', info: clean },
      { sessionId: 'nope', root: '/work/Z', info: clean },
    ]);
    expect(h.calls).toBe(1);
    expect(h.store.get('s1')?.repoGit).not.toBe(before);
    expect(h.store.get('s1')?.repoGit?.['/work/A']?.dirty).toBe(true);
    expect(h.store.get('s1')?.repoGit?.['/work/X']).toEqual(clean);
    expect(h.store.get('s2')?.repoGit).toEqual({ '/work/B': clean });
    const after = h.store.get('s1')?.repoGit;
    h.store.mergeRepoGit([
      { sessionId: 's1', root: '/work/A', info: { ...clean, dirty: true } },
      { sessionId: 's2', root: '/work/B', info: { ...clean } },
    ]);
    expect(h.calls).toBe(1);
    expect(h.store.get('s1')?.repoGit).toBe(after);
    expect(h.store.get('nope')).toBeUndefined();
  });

  it('setRepos drops repoGit entries for repos that left the session', () => {
    const h = storeWith();
    h.store.setRepos('s1', repos);
    h.store.setRepoGit('s1', { '/work/A': clean, '/work/B': clean, '/work/gone': clean });
    h.calls = 0;
    expect(h.store.setRepos('s1', [...repos])).toBe(true);
    expect(h.calls).toBe(1);
    expect(Object.keys(h.store.get('s1')?.repoGit ?? {}).sort()).toEqual(['/work/A', '/work/B']);
    expect(h.store.setRepos('s1', [...repos])).toBe(false);
    expect(h.store.setRepos('s1', [repos[0]])).toBe(true);
    expect(Object.keys(h.store.get('s1')?.repoGit ?? {})).toEqual(['/work/A']);
  });
});

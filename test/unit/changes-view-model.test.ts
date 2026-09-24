import { describe, expect, it } from 'vitest';
import { acceptRepoChanges, changesModel } from '../../src/changes-view-model';
import type { ChangeDTO, RepoChanges } from '../../src/protocol';
import type { RepoInfo } from '../../src/repo-scan';

const repo = (root: string): RepoInfo => ({ root, name: root, folder: root, tag: 'attached' });
const rc = (root: string): RepoChanges => ({ root, name: root, tag: 'attached', changes: [] });

describe('acceptRepoChanges', () => {
  const prev = [rc('/a')];

  it('matching set adopted', () => {
    const incoming = [rc('/b'), rc('C:/A')];
    expect(acceptRepoChanges(prev, incoming, [repo('c:/a/'), repo('/b')])).toBe(incoming);
  });

  it('stale set (repo added since request) keeps prev', () => {
    expect(acceptRepoChanges(prev, [rc('/a')], [repo('/a'), repo('/b')])).toBe(prev);
  });

  it('undefined incoming keeps prev', () => {
    expect(acceptRepoChanges(prev, undefined, [repo('/a')])).toBe(prev);
  });

  it('repos undefined keeps prev', () => {
    expect(acceptRepoChanges(prev, [], undefined)).toBe(prev);
  });

  it('an empty set is adopted when no repos were found', () => {
    const incoming: RepoChanges[] = [];
    expect(acceptRepoChanges(prev, incoming, [])).toBe(incoming);
  });
});

const ch = (path: string, staged: boolean, added = 1, removed = 0): ChangeDTO => ({
  path,
  added,
  removed,
  kind: 'M',
  staged,
});
const info = (root: string, tag: RepoInfo['tag'], folder = root): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder,
  tag,
});
const entry = (r: RepoInfo, changes: ChangeDTO[]): RepoChanges => ({
  root: r.root,
  name: r.name,
  tag: r.tag,
  changes,
});

describe('changesModel', () => {
  const home = info('/w/home', 'home');
  const nested = info('/w/home/vendor/lib', 'nested', '/w/home');
  const ref = info('/x/ref', 'attached');
  const repos = [ref, nested, home];
  const session = { repos, roots: ['/x/ref'], activeRepoRoot: '/x/ref', repoPinned: true };
  const full = [
    entry(home, [ch('a.txt', false, 3, 1)]),
    entry(nested, []),
    entry(ref, [ch('b.txt', true, 2, 2), ch('c.txt', false, 1, 0)]),
  ];

  it('no session → no-session', () => {
    expect(changesModel({ session: undefined, repoChanges: full, view: 'all' })).toEqual({
      kind: 'no-session',
    });
  });

  it('repos undefined → detecting', () => {
    const m = changesModel({ session: { roots: [] }, repoChanges: undefined, view: 'all' });
    expect(m).toEqual({ kind: 'detecting' });
  });

  it('repos [] → no-repos', () => {
    const m = changesModel({ session: { repos: [], roots: [] }, repoChanges: [], view: 'all' });
    expect(m).toEqual({ kind: 'no-repos' });
  });

  it('all view: one head per repo in display order, count/added/removed summed', () => {
    const m = changesModel({ session, repoChanges: full, view: 'all' });
    if (m.kind !== 'ready') throw new Error(m.kind);
    expect(m.heads.map((h) => h.repo.root)).toEqual(['/w/home', '/w/home/vendor/lib', '/x/ref']);
    expect(m.repos.map((r) => r.root)).toEqual(['/w/home', '/w/home/vendor/lib', '/x/ref']);
    expect([m.count, m.added, m.removed]).toEqual([3, 6, 3]);
    expect(m.pinned).toBe(true);
    expect(m.activeRoot).toBe('/x/ref');
    expect(m.heads[1].sub).toBe('home/vendor/lib');
    expect(m.heads[0].label).toBe('home');
  });

  it('active view: exactly the active repo; activeRoot falls back to first', () => {
    const pinnedRef = changesModel({ session, repoChanges: full, view: 'active' });
    if (pinnedRef.kind !== 'ready') throw new Error(pinnedRef.kind);
    expect(pinnedRef.heads.map((h) => h.repo.root)).toEqual(['/x/ref']);
    expect(pinnedRef.count).toBe(2);
    const fallback = changesModel({
      session: { repos, roots: ['/x/ref'] },
      repoChanges: full,
      view: 'active',
    });
    if (fallback.kind !== 'ready') throw new Error(fallback.kind);
    expect(fallback.activeRoot).toBe('/w/home');
    expect(fallback.heads.map((h) => h.repo.root)).toEqual(['/w/home']);
    expect(fallback.pinned).toBe(false);
  });

  it('active repo matched by folder key', () => {
    const m = changesModel({
      session: {
        repos: [info('C:/w/a', 'home'), info('C:/w/b', 'attached')],
        roots: ['C:/w/b'],
        activeRepoRoot: 'c:/w/b/',
      },
      repoChanges: [],
      view: 'active',
    });
    if (m.kind !== 'ready') throw new Error(m.kind);
    expect(m.heads.map((h) => h.repo.root)).toEqual(['C:/w/b']);
  });

  it('a repo missing from repoChanges → changes undefined, loading true, excluded from count', () => {
    const m = changesModel({ session, repoChanges: [full[0]], view: 'all' });
    if (m.kind !== 'ready') throw new Error(m.kind);
    expect(m.heads.map((h) => h.changes === undefined)).toEqual([false, true, true]);
    expect(m.heads[2].staged).toEqual([]);
    expect(m.loading).toBe(true);
    expect(m.count).toBe(1);
    expect(m.allClean).toBe(false);
  });

  it('lookup is by folder key', () => {
    const m = changesModel({
      session: { repos: [info('C:/w/a', 'home')], roots: [] },
      repoChanges: [{ root: 'c:/w/a', name: 'a', tag: 'home', changes: [ch('x', false)] }],
      view: 'all',
    });
    if (m.kind !== 'ready') throw new Error(m.kind);
    expect(m.count).toBe(1);
  });

  it('allClean only when loaded and zero', () => {
    const clean = full.map((e) => ({ ...e, changes: [] }));
    const m = changesModel({ session, repoChanges: clean, view: 'all' });
    if (m.kind !== 'ready') throw new Error(m.kind);
    expect([m.allClean, m.loading, m.count]).toEqual([true, false, 0]);
    const loading = changesModel({ session, repoChanges: undefined, view: 'all' });
    if (loading.kind !== 'ready') throw new Error(loading.kind);
    expect([loading.allClean, loading.loading]).toEqual([false, true]);
  });

  it('staged/unstaged split per head', () => {
    const m = changesModel({ session, repoChanges: full, view: 'all' });
    if (m.kind !== 'ready') throw new Error(m.kind);
    const r = m.heads[2];
    expect(r.staged.map((c) => c.path)).toEqual(['b.txt']);
    expect(r.unstaged.map((c) => c.path)).toEqual(['c.txt']);
    expect(m.heads[0].staged).toEqual([]);
    expect(m.heads[0].unstaged.map((c) => c.path)).toEqual(['a.txt']);
  });
});

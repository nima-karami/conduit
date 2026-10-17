import { describe, expect, it } from 'vitest';
import {
  applyRepoDelta,
  changesModel,
  repoChangesOf,
  type SessionSnapshots,
} from '../../src/changes-view-model';
import type { ChangeDTO, HostToWebview, RepoChanges, RepoSnapshot } from '../../src/protocol';
import type { RepoInfo } from '../../src/repo-scan';

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
  lines: true,
  refreshedAt: 1,
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
      repoChanges: [
        {
          root: 'c:/w/a',
          name: 'a',
          tag: 'home',
          changes: [ch('x', false)],
          lines: true,
          refreshedAt: 1,
        },
      ],
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

const snap = (changes: ChangeDTO[] = [], extra: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  changes,
  lines: true,
  refreshedAt: 5,
  ...extra,
});
const delta = (
  sessionId: string,
  full: boolean,
  repos: Record<string, RepoSnapshot | { removed: true }>,
): Extract<HostToWebview, { type: 'repoDelta' }> => ({ type: 'repoDelta', sessionId, full, repos });

describe('applyRepoDelta', () => {
  it('full replaces, incremental merges, removed deletes, hidden sessions dropped', () => {
    const a = snap([ch('a', false)]);
    const b = snap([ch('b', false)]);
    const c = snap([ch('c', false)]);
    const prev: SessionSnapshots = { s1: { '/a': a, '/b': b }, s2: { '/z': snap() } };

    const full = applyRepoDelta(prev, delta('s1', true, { '/c': c, '/gone': { removed: true } }), [
      's1',
      's2',
    ]);
    expect(full.s1).toEqual({ '/c': c });
    expect(full.s2).toBe(prev.s2);

    const merged = applyRepoDelta(prev, delta('s1', false, { '/b': c }), ['s1', 's2']);
    expect(merged.s1).toEqual({ '/a': a, '/b': c });

    const removed = applyRepoDelta(prev, delta('s1', false, { '/a': { removed: true } }), ['s1']);
    expect(removed.s1).toEqual({ '/b': b });

    const hidden = applyRepoDelta(prev, delta('s1', false, { '/b': c }), ['s1']);
    expect(Object.keys(hidden)).toEqual(['s1']);
    const hiddenMsg = applyRepoDelta(prev, delta('s3', true, { '/q': c }), ['s1', 's2']);
    expect(Object.keys(hiddenMsg)).toEqual(['s1', 's2']);

    expect(prev.s1).toEqual({ '/a': a, '/b': b });
  });

  it('an incremental delta creates the session map when absent', () => {
    const a = snap();
    expect(applyRepoDelta({}, delta('s1', false, { '/a': a }), ['s1'])).toEqual({
      s1: { '/a': a },
    });
  });
});

describe('repoChangesOf', () => {
  const r1 = info('C:/w/a', 'home');
  const r2 = info('/w/b', 'nested', '/w');

  it('undefined repos → undefined', () => {
    expect(repoChangesOf(undefined, { x: snap() })).toBeUndefined();
  });

  it('yields only repos with snapshots so missing ones read as loading', () => {
    const out = repoChangesOf([r1, r2], { '/w/b': snap([ch('x', false)]) });
    expect(out?.map((e) => e.root)).toEqual(['/w/b']);
    expect(out?.[0]).toEqual({
      root: '/w/b',
      name: 'b',
      tag: 'nested',
      sub: expect.any(String),
      changes: [ch('x', false)],
      lines: true,
      refreshedAt: 5,
    });
    expect(repoChangesOf([r1], undefined)).toEqual([]);
    expect(repoChangesOf([], {})).toEqual([]);
  });

  it('keeps repo order and matches by folder key when spelling differs', () => {
    const out = repoChangesOf([r2, r1], { 'c:/w/a/': snap(), '/w/b': snap() });
    expect(out?.map((e) => e.root)).toEqual(['/w/b', 'C:/w/a']);
  });

  it('carries stale, error and refreshedAt 0 through', () => {
    const error = { kind: 'timeout' } as unknown as NonNullable<RepoSnapshot['error']>;
    const out = repoChangesOf([r1], { 'C:/w/a': snap([], { stale: true, refreshedAt: 0, error }) });
    expect(out?.[0]).toMatchObject({ stale: true, refreshedAt: 0, error, changes: [] });
  });
});

describe('changesModel snapshot fields', () => {
  const r = info('/w/a', 'home');
  const session = { repos: [r], roots: [] };

  it('linesPending when any loaded head has lines:false', () => {
    const pending = changesModel({
      session,
      repoChanges: [{ ...entry(r, [ch('a', false)]), lines: false }],
      view: 'all',
    });
    if (pending.kind !== 'ready') throw new Error(pending.kind);
    expect(pending.linesPending).toBe(true);
    const done = changesModel({ session, repoChanges: [entry(r, [ch('a', false)])], view: 'all' });
    if (done.kind !== 'ready') throw new Error(done.kind);
    expect(done.linesPending).toBe(false);
    const notLoaded = changesModel({ session, repoChanges: [], view: 'all' });
    if (notLoaded.kind !== 'ready') throw new Error(notLoaded.kind);
    expect(notLoaded.linesPending).toBe(false);
  });

  it('repoChangesOf carries stale and refreshedAt through to the head model', () => {
    const repoChanges = repoChangesOf([r], {
      '/w/a': snap([ch('a', false)], { stale: true, refreshedAt: 42 }),
    });
    const m = changesModel({ session, repoChanges, view: 'all' });
    if (m.kind !== 'ready') throw new Error(m.kind);
    expect(m.heads[0]).toMatchObject({ stale: true, refreshedAt: 42, lines: true });
  });
});

describe('changesModel never-read repo', () => {
  it('a failed first read (refreshedAt 0) stays loading and carries the error', () => {
    const repo = { root: '/w/a', name: 'a', folder: '/w/a', tag: 'home' as const };
    const model = changesModel({
      session: { repos: [repo], roots: [], activeRepoRoot: '/w/a' },
      repoChanges: [
        {
          root: '/w/a',
          name: 'a',
          tag: 'home',
          changes: [],
          lines: false,
          refreshedAt: 0,
          error: 'timeout',
        },
      ],
      view: 'all',
    });
    if (model.kind !== 'ready') throw new Error(model.kind);
    expect(model.heads[0].changes).toBeUndefined();
    expect(model.heads[0].error).toBe('timeout');
    expect(model.loading).toBe(true);
    expect(model.allClean).toBe(false);
  });
});

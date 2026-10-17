import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRepoTrackerHost } from '../../electron/repo-tracker-host';
import type { watchDirWhilePresent } from '../../electron/watch-dir';
import type { GitInterrogation } from '../../src/git-info';
import type { HostToWebview } from '../../src/protocol';
import { RepoPathMap } from '../../src/repo-path-map';
import type { RepoInfo } from '../../src/repo-scan';
import type { GitInfo, Session } from '../../src/types';

type Delta = Extract<HostToWebview, { type: 'repoDelta' }>;

const repo = (root: string): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder: root,
  tag: 'home',
});

interface FakeWatch {
  dir: string;
  emit: (filename: string | null) => void;
  closed: boolean;
}

function harness(opts: { git?: Record<string, GitInterrogation> } = {}) {
  const sessions = new Map<string, Session>();
  const shown = new Map<number, Set<string>>();
  const suspended = new Set<number>();
  const owner = new Map<string, number>();
  const warn = vi.fn();
  const sent = new Map<number, HostToWebview[]>();
  const reads: Array<{ root: string; lines: boolean }> = [];
  const merges: Array<{ sessionId: string; root: string; info: GitInfo }> = [];
  const watches: FakeWatch[] = [];
  const fakeWatch: typeof watchDirWhilePresent = (dir, _o, onEvent) => {
    const w: FakeWatch = {
      dir,
      emit: (f) => onEvent('change', f),
      closed: false,
    };
    watches.push(w);
    return {
      close() {
        w.closed = true;
      },
    };
  };
  const host = createRepoTrackerHost({
    mgr: {
      get: (id: string) => sessions.get(id),
      list: () => [],
      mergeRepoGit: (patches) => merges.push(...patches),
    },
    demand: {
      isVisible: (id) => [...shown].some(([w, ids]) => !suspended.has(w) && ids.has(id)),
      isShownInWindow: (w, id) => shown.get(w)?.has(id) === true,
      shownIn: (w) => [...(shown.get(w) ?? [])],
    },
    owns: (w, id) => owner.get(id) === w,
    windows: () =>
      [1, 2].map((id) => ({
        id,
        send: (msg: HostToWebview) => sent.set(id, [...(sent.get(id) ?? []), msg]),
      })),
    log: { debug: vi.fn(), warn },
    watchDirWhilePresent: fakeWatch,
    trackerDeps: {
      async readChanges(root, o) {
        reads.push({ root, lines: o.lines });
        return {
          ok: true,
          changes: [{ path: 'a.txt', added: 0, removed: 0, kind: 'U', staged: false }],
          trackedDirty: false,
        };
      },
      async interrogate(root) {
        return (
          opts.git?.[root] ?? {
            info: { kind: 'branch', branch: 'main' },
            gitDir: `${root}/.git`,
            commonDir: `${root}/.git`,
          }
        );
      },
      indexMtime: async () => 0,
    },
  });
  const addSession = (id: string, repos: RepoInfo[], ownerWindow = 1) => {
    owner.set(id, ownerWindow);
    sessions.set(id, {
      id,
      name: id,
      agentId: 'shell:cmd',
      home: '/w',
      roots: [],
      status: 'running',
      createdAt: 0,
      lastActiveAt: 0,
      repos,
    });
    host.tracker.setSessionRepos(id, repos);
  };
  const deltas = (windowId: number) =>
    (sent.get(windowId) ?? []).filter((m): m is Delta => m.type === 'repoDelta');
  return {
    host,
    sessions,
    shown,
    suspended,
    warn,
    sent,
    reads,
    merges,
    watches,
    addSession,
    deltas,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('publish sends repoDelta only to windows where a containing session is visible', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.shown.set(2, new Set(['s3']));
  h.addSession('s1', [repo('/w/a')]);
  h.addSession('s2', [repo('/w/a')]);
  await vi.advanceTimersByTimeAsync(10);
  expect(h.reads).toHaveLength(1);
  expect(h.deltas(1).map((d) => [d.sessionId, d.full, Object.keys(d.repos)])).toEqual([
    ['s1', false, ['/w/a']],
  ]);
  expect(h.deltas(2)).toEqual([]);
  expect(h.merges.map((m) => m.sessionId).sort()).toEqual(['s1', 's2']);
  h.host.stop();
});

it('windowShown sends a full repoDelta from cache with no git', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/w/a')]);
  h.addSession('s2', [repo('/w/a')], 2);
  await vi.advanceTimersByTimeAsync(10);
  const before = h.reads.length;
  h.shown.set(2, new Set(['s2']));
  h.host.windowShown(2, ['s2', 'ghost']);
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.reads).toHaveLength(before);
  const full = h.deltas(2).filter((d) => d.full);
  expect(full.map((d) => d.sessionId)).toEqual(['s2']);
  expect(full[0].repos['/w/a']).toMatchObject({ changes: [{ path: 'a.txt' }], lines: false });
  h.host.stop();
});

it('windowShown with the same window and the same ids sends full deltas again', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/w/a')]);
  await vi.advanceTimersByTimeAsync(10);
  h.host.windowShown(1, ['s1']);
  h.host.windowShown(1, ['s1']);
  expect(h.deltas(1).filter((d) => d.full && d.sessionId === 's1')).toHaveLength(2);
  h.host.stop();
});

it('line demand is per-window set-replace; dropWindow removes its refs', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/w/a')]);
  await vi.advanceTimersByTimeAsync(10);
  expect(h.reads.at(-1)).toEqual({ root: '/w/a', lines: false });
  h.host.setLinesDemand(1, ['s1', 'ghost']);
  h.host.setLinesDemand(2, ['s1']);
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.reads.at(-1)).toEqual({ root: '/w/a', lines: true });
  h.host.setLinesDemand(1, []);
  h.host.dropWindow(2);
  h.host.refresh('s1', '/w/a');
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.reads.at(-1)).toEqual({ root: '/w/a', lines: false });
  h.host.stop();
});

it('refresh rejects a root outside the session repos', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1', 's2']));
  h.addSession('s1', [repo('/w/a')]);
  h.addSession('s2', [repo('/w/b')]);
  await vi.advanceTimersByTimeAsync(1100);
  const before = h.reads.length;
  h.host.refresh('s1', '/w/b');
  h.host.refresh('ghost', '/w/a');
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.reads).toHaveLength(before);
  h.host.refresh('s1', '/w/a/');
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.reads.slice(before).map((r) => r.root)).toEqual(['/w/a']);
  h.host.stop();
});

const worktreeGit = (): Record<string, GitInterrogation> => ({
  '/t/wt': {
    info: { kind: 'branch', branch: 'x' },
    gitDir: '/m/.git/worktrees/wt',
    commonDir: '/m/.git',
  },
});

it('common-dir objects/ab/cd, logs/HEAD, index.lock and refs/heads/x.lock never reach classify; refs/heads/x and worktrees/w/HEAD do', async () => {
  const h = harness({ git: worktreeGit() });
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/t/wt')]);
  await vi.advanceTimersByTimeAsync(10);
  const watch = h.watches.find((w) => w.dir === '/m/.git' && !w.closed);
  expect(watch).toBeDefined();
  const settle = async () => vi.advanceTimersByTimeAsync(1500);
  await settle();
  const base = h.reads.length;
  const classify = vi.spyOn(RepoPathMap.prototype, 'classify');
  for (const f of ['objects/ab/cd', 'logs/HEAD', 'index.lock', 'refs\\heads\\x.lock']) {
    watch?.emit(f);
    await settle();
  }
  expect(h.reads).toHaveLength(base);
  expect(classify).not.toHaveBeenCalled();
  watch?.emit('refs\\heads\\x');
  expect(classify).toHaveBeenLastCalledWith('/m/.git/refs/heads/x');
  await settle();
  expect(h.reads).toHaveLength(base + 1);
  watch?.emit('worktrees/wt/HEAD');
  await settle();
  expect(h.reads).toHaveLength(base + 2);
  watch?.emit('worktrees/wt/index');
  await settle();
  expect(h.reads).toHaveLength(base + 3);
  h.host.stop();
  expect(watch?.closed).toBe(true);
});

it('a null filename from the common-dir watch calls onLost', async () => {
  const h = harness({ git: worktreeGit() });
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/t/wt')]);
  await vi.advanceTimersByTimeAsync(1500);
  const base = h.reads.length;
  h.watches.find((w) => w.dir === '/m/.git')?.emit(null);
  await vi.advanceTimersByTimeAsync(1500);
  expect(h.reads).toHaveLength(base + 1);
  h.host.stop();
});

it('removed sends a removed entry to the visible session that dropped the repo', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/w/a')]);
  await vi.advanceTimersByTimeAsync(10);
  h.addSession('s1', []);
  expect(h.deltas(1).at(-1)).toEqual({
    type: 'repoDelta',
    sessionId: 's1',
    full: false,
    repos: { '/w/a': { removed: true } },
  });
  h.host.stop();
});

it('a minimized window still gets deltas for its own sessions, and restore re-sends them in full', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.shown.set(2, new Set(['s2']));
  h.addSession('s1', [repo('/w/a')], 1);
  h.addSession('s2', [repo('/w/a')], 2);
  await vi.advanceTimersByTimeAsync(10);
  h.suspended.add(1);
  h.sent.clear();
  h.host.tracker.onWatchedPath('/w/a/a.txt');
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.deltas(1).map((d) => [d.sessionId, d.full])).toEqual([['s1', false]]);
  h.suspended.delete(1);
  h.sent.clear();
  const reads = h.reads.length;
  h.host.windowRestored(1);
  expect(h.deltas(1).map((d) => [d.sessionId, d.full, Object.keys(d.repos)])).toEqual([
    ['s1', true, ['/w/a']],
  ]);
  expect(h.reads).toHaveLength(reads);
  h.host.stop();
});

it('windowShown and line demand ignore sessions the calling window does not own', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/w/a')], 1);
  await vi.advanceTimersByTimeAsync(10);
  h.host.windowShown(2, ['s1']);
  expect(h.deltas(2)).toEqual([]);
  h.host.setLinesDemand(2, ['s1']);
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.reads.every((r) => !r.lines)).toBe(true);
  h.host.windowRestored(2);
  expect(h.deltas(2)).toEqual([]);
  h.host.stop();
});

it("a window that reports another window's session as visible gets none of its deltas", async () => {
  const h = harness();
  h.addSession('s1', [repo('/w/a')], 1);
  expect(h.host.ownedIds(2, ['s1', 'ghost'])).toEqual([]);
  expect(h.host.ownedIds(1, ['s1', 'ghost'])).toEqual(['s1']);
  // The demand set as an unfiltered `visible` would have left it.
  h.shown.set(1, new Set(['s1']));
  h.shown.set(2, new Set(['s1']));
  await vi.advanceTimersByTimeAsync(10);
  h.host.tracker.onWatchedPath('/w/a/a.txt');
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.deltas(1).length).toBeGreaterThan(0);
  expect(h.deltas(2)).toEqual([]);
  h.host.stop();
});

it('a malformed changes:subscribe or repo:refresh payload is logged and ignored', async () => {
  const h = harness();
  h.shown.set(1, new Set(['s1']));
  h.addSession('s1', [repo('/w/a')], 1);
  await vi.advanceTimersByTimeAsync(2000);
  const reads = h.reads.length;
  for (const bad of ['s1', [1], null, undefined, { 0: 's1' }])
    expect(() => h.host.setLinesDemand(1, bad)).not.toThrow();
  for (const bad of [42, null, undefined, ['/w/a']])
    expect(() => h.host.refresh('s1', bad)).not.toThrow();
  expect(() => h.host.refresh(7, '/w/a')).not.toThrow();
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.reads).toHaveLength(reads);
  expect(h.warn).toHaveBeenCalledTimes(10);
  h.host.stop();
});

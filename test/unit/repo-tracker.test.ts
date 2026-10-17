import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../src/folder-key';
import type { GitInterrogation } from '../../src/git-info';
import type { RepoRead } from '../../src/project-info';
import type { ChangeDTO } from '../../src/protocol';
import { REFRESH_COOLDOWN_MS, REFRESH_SETTLE_MS } from '../../src/repo-refresh-scheduler';
import type { RepoInfo, RepoTag } from '../../src/repo-scan';
import {
  createRepoTracker,
  FOCUS_PRIORITY,
  FOCUS_STALE_MS,
  type RepoTrackerDeps,
  type TrackerUpdate,
} from '../../src/repo-tracker';

const info = (root: string, tag: RepoTag = 'nested', name = root.split('/').pop() ?? root) =>
  ({ root, name, folder: root, tag }) satisfies RepoInfo;

const change = (path: string): ChangeDTO => ({
  path,
  added: 0,
  removed: 0,
  kind: 'M',
  staged: false,
});

interface Watch {
  dir: string;
  onPath: (absKey: string) => void;
  onLost: () => void;
  closed: boolean;
}

function harness() {
  const visible = new Set<string>();
  const wants = new Set<string>();
  const reads: Array<{ root: string; lines: boolean }> = [];
  const interrogations: string[] = [];
  const watches: Watch[] = [];
  const updates: TrackerUpdate[] = [];
  const removals: Array<{ key: string; root: string; sessions: readonly string[] }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const readResult = new Map<string, RepoRead>();
  const git = new Map<string, GitInterrogation>();
  const mtimes = new Map<string, number>();
  let interrogateGate: Promise<void> | undefined;
  let readGate: Promise<void> | undefined;
  const deps: RepoTrackerDeps = {
    async readChanges(root, opts) {
      reads.push({ root, lines: opts.lines });
      if (readGate) await readGate;
      return readResult.get(root) ?? { ok: true, changes: [], trackedDirty: false };
    },
    async interrogate(root) {
      interrogations.push(root);
      if (interrogateGate) await interrogateGate;
      return (
        git.get(root) ?? {
          info: { kind: 'branch', branch: 'main' },
          gitDir: `${root}/.git`,
          commonDir: `${root}/.git`,
        }
      );
    },
    isSessionVisible: (id) => visible.has(id),
    wantsLines: (id) => wants.has(id),
    watchGitDir(dir, onPath, onLost) {
      const w: Watch = { dir, onPath, onLost, closed: false };
      watches.push(w);
      return {
        close() {
          w.closed = true;
        },
      };
    },
    indexMtime: async (root) => mtimes.get(root) ?? 0,
    publish: (u) => updates.push(u),
    removed: (key, root, sessions) => removals.push({ key, root, sessions }),
    log: (level, msg) => logs.push({ level, msg }),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const tracker = createRepoTracker(deps);
  return {
    tracker,
    visible,
    wants,
    reads,
    interrogations,
    watches,
    updates,
    removals,
    logs,
    readResult,
    git,
    mtimes,
    openWatches: () => watches.filter((w) => !w.closed).map((w) => w.dir),
    gateInterrogations() {
      let release = () => {};
      interrogateGate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        interrogateGate = undefined;
        release();
      };
    },
    gateReads() {
      let release = () => {};
      readGate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        readGate = undefined;
        release();
      };
    },
    clear() {
      reads.length = 0;
      interrogations.length = 0;
      updates.length = 0;
    },
  };
}

const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
/** Long enough for any settle + cooldown to elapse. */
const settleAll = () => flush(REFRESH_SETTLE_MS + REFRESH_COOLDOWN_MS + 50);
const edit = (path: string) => folderKey(path);

beforeEach(() => {
  vi.useFakeTimers({ now: 5_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createRepoTracker', () => {
  it('two sessions sharing a repo cause one readChanges and one publish listing both sessions', async () => {
    const h = harness();
    h.visible.add('s1').add('s2');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    h.tracker.setSessionRepos('s2', [info('/w/A', 'attached')]);
    await settleAll();
    expect(h.reads).toEqual([{ root: '/w/A', lines: false }]);
    const withSnapshot = h.updates.filter((u) => u.snapshot);
    expect(withSnapshot).toHaveLength(1);
    expect([...withSnapshot[0].sessions].sort()).toEqual(['s1', 's2']);
    expect(withSnapshot[0].git).toEqual({ kind: 'branch', branch: 'main', dirty: false });
  });

  it('an edit dirties only its repo', async () => {
    const h = harness();
    h.visible.add('s1');
    const repos = Array.from({ length: 36 }, (_, i) => info(`/w/r${i}`));
    h.tracker.setSessionRepos('s1', repos);
    await flush(10_000);
    expect(h.reads).toHaveLength(36);
    h.clear();
    h.tracker.onWatchedPath(edit('/w/r7/src/a.ts'));
    await settleAll();
    expect(h.reads.map((r) => r.root)).toEqual(['/w/r7']);
    expect(h.interrogations).toEqual([]);
  });

  it('a loose path dirties nothing', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A')]);
    await settleAll();
    h.clear();
    h.tracker.onWatchedPath(edit('/w/notes.md'));
    await settleAll();
    expect(h.reads).toEqual([]);
  });

  it('repo contained only by hidden sessions runs no git; becoming visible runs it once', async () => {
    const h = harness();
    h.tracker.setSessionRepos('bg', [info('/w/A', 'home')]);
    h.tracker.onWatchedPath(edit('/w/A/x.ts'));
    await flush(60_000);
    expect(h.reads).toEqual([]);
    expect(h.interrogations).toEqual([]);
    h.visible.add('bg');
    h.tracker.visibilityChanged();
    await flush(60_000);
    expect(h.reads).toHaveLength(1);
    expect(h.interrogations).toHaveLength(1);
  });

  it('background session gets the snapshot via publish.sessions without its own run', async () => {
    const h = harness();
    h.visible.add('front');
    h.readResult.set('/w/A', { ok: true, changes: [change('a.ts')], trackedDirty: true });
    h.tracker.setSessionRepos('front', [info('/w/A', 'home')]);
    h.tracker.setSessionRepos('bg', [info('/w/A', 'nested')]);
    await settleAll();
    h.clear();
    h.tracker.onWatchedPath(edit('/w/A/a.ts'));
    await settleAll();
    expect(h.reads).toHaveLength(1);
    expect([...h.updates[0].sessions].sort()).toEqual(['bg', 'front']);
    expect(h.tracker.snapshotsFor('bg')['/w/A'].changes).toEqual([change('a.ts')]);
  });

  it('a session joining an already-read repo gets the cached snapshot without a run', async () => {
    const h = harness();
    h.visible.add('s1').add('s2');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    h.clear();
    h.tracker.setSessionRepos('s2', [info('/w/A', 'attached')]);
    await settleAll();
    expect(h.reads).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect([...h.updates[0].sessions].sort()).toEqual(['s1', 's2']);
    expect(h.updates[0].snapshot).toBeDefined();
    expect(h.updates[0].git).toEqual({ kind: 'branch', branch: 'main', dirty: false });
  });

  it('lines follows demand; demand rise re-reads lines:false repos immediately', async () => {
    const h = harness();
    h.visible.add('s1').add('s2');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    h.tracker.setSessionRepos('s2', [info('/w/B', 'home')]);
    await settleAll();
    expect(h.reads.every((r) => !r.lines)).toBe(true);
    h.clear();
    h.wants.add('s1');
    h.tracker.linesDemandChanged();
    await flush(0);
    expect(h.reads).toEqual([{ root: '/w/A', lines: true }]);
    expect(h.tracker.snapshotsFor('s1')['/w/A'].lines).toBe(true);
    h.clear();
    h.tracker.linesDemandChanged();
    await settleAll();
    expect(h.reads).toEqual([]);
  });

  it('a demand rise during a run already reading lines adds no second run', async () => {
    const h = harness();
    h.visible.add('s1');
    h.wants.add('s1');
    const release = h.gateReads();
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await flush(0);
    expect(h.reads).toEqual([{ root: '/w/A', lines: true }]);
    h.tracker.linesDemandChanged();
    release();
    await settleAll();
    expect(h.reads).toEqual([{ root: '/w/A', lines: true }]);
  });

  it('a demand rise during a run reading names only re-reads with lines', async () => {
    const h = harness();
    h.visible.add('s1');
    const release = h.gateReads();
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await flush(0);
    h.wants.add('s1');
    h.tracker.linesDemandChanged();
    release();
    await settleAll();
    expect(h.reads).toEqual([
      { root: '/w/A', lines: false },
      { root: '/w/A', lines: true },
    ]);
  });

  it('a failed run that was reading lines re-marks the repo for lines once', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    h.clear();
    const release = h.gateReads();
    h.wants.add('s1');
    h.tracker.linesDemandChanged();
    await flush(0);
    h.tracker.linesDemandChanged();
    h.readResult.set('/w/A', { ok: false, reason: 'timeout' });
    release();
    await settleAll();
    expect(h.reads).toEqual([
      { root: '/w/A', lines: true },
      { root: '/w/A', lines: true },
    ]);
    await flush(60_000);
    expect(h.reads).toHaveLength(2);
    h.readResult.set('/w/A', { ok: true, changes: [], trackedDirty: false });
    h.tracker.onWatchedPath(edit('/w/A/a.ts'));
    await settleAll();
    expect(h.tracker.snapshotsFor('s1')['/w/A'].lines).toBe(true);
  });

  it('removing a repo forgets it and reports removal with the sessions that dropped it', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home'), info('/w/B')]);
    await settleAll();
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    expect(h.removals).toEqual([{ key: folderKey('/w/B'), root: '/w/B', sessions: ['s1'] }]);
    h.clear();
    h.tracker.onWatchedPath(edit('/w/B/x.ts'));
    await settleAll();
    expect(h.reads).toEqual([]);
    expect(h.tracker.snapshotsFor('s1')['/w/B']).toBeUndefined();
    h.tracker.dropSession('s1');
    expect(h.removals.map((r) => r.root)).toEqual(['/w/B', '/w/A']);
  });

  it('a run that completes after its repo was removed publishes nothing', async () => {
    const h = harness();
    h.visible.add('s1');
    const release = h.gateInterrogations();
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await flush(0);
    expect(h.interrogations).toEqual(['/w/A']);
    h.tracker.dropSession('s1');
    release();
    await settleAll();
    expect(h.updates).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it('a status read that completes after its repo was removed publishes nothing', async () => {
    const h = harness();
    h.visible.add('s1');
    const release = h.gateReads();
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await flush(0);
    expect(h.reads).toHaveLength(1);
    h.tracker.dropSession('s1');
    release();
    await settleAll();
    expect(h.updates).toEqual([]);
    expect(h.tracker.snapshotsFor('s1')).toEqual({});
  });

  it('meta run arms one git-dir watch per uncovered commonDir, shared by worktrees; released on last removal', async () => {
    const h = harness();
    h.visible.add('s1');
    h.git.set('/t/1/A', {
      info: { kind: 'branch', branch: 't1', isWorktree: true, worktreeName: 'A' },
      gitDir: '/w/A/.git/worktrees/A',
      commonDir: '/w/A/.git',
    });
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home'), info('/t/1/A')]);
    await settleAll();
    expect(h.openWatches()).toEqual([folderKey('/w/A/.git')]);
    h.tracker.setSessionRepos('s1', [info('/t/1/A')]);
    expect(h.openWatches()).toEqual([folderKey('/w/A/.git')]);
    h.tracker.setSessionRepos('s1', []);
    expect(h.openWatches()).toEqual([]);
    expect(h.watches).toHaveLength(1);
  });

  it('no own git-dir watch while a live root covers the commonDir; opened when that root goes, closed when it returns', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setLiveRoots(['/w']);
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    expect(h.openWatches()).toEqual([]);
    h.tracker.setLiveRoots([]);
    expect(h.openWatches()).toEqual([folderKey('/w/A/.git')]);
    h.tracker.setLiveRoots(['/w']);
    expect(h.openWatches()).toEqual([]);
  });

  it('worktree index event from the git-dir watch refreshes that worktree', async () => {
    const h = harness();
    h.visible.add('s1');
    h.git.set('/t/1/A', {
      info: { kind: 'branch', branch: 't1', isWorktree: true, worktreeName: 'A' },
      gitDir: '/w/A/.git/worktrees/A',
      commonDir: '/w/A/.git',
    });
    h.tracker.setSessionRepos('s1', [info('/t/1/A', 'home')]);
    await settleAll();
    h.clear();
    const [w] = h.watches;
    w.onPath(edit('/w/A/.git/worktrees/A/index'));
    await settleAll();
    expect(h.reads.map((r) => r.root)).toEqual(['/t/1/A']);
    expect(h.interrogations).toEqual([]);
    h.clear();
    w.onPath(edit('/w/A/.git/refs/heads/t1'));
    await settleAll();
    expect(h.interrogations).toEqual(['/t/1/A']);
  });

  it('a timed-out interrogation keeps the last good git dirs, branch, info and watch; the next fire retries it', async () => {
    const h = harness();
    h.visible.add('s1');
    const good: GitInterrogation = {
      info: { kind: 'branch', branch: 't1', isWorktree: true, worktreeName: 'A' },
      gitDir: '/w/A/.git/worktrees/A',
      commonDir: '/w/A/.git',
    };
    h.git.set('/t/1/A', good);
    h.tracker.setSessionRepos('s1', [info('/t/1/A', 'home')]);
    await settleAll();
    const [w] = h.watches;
    h.clear();
    h.git.set('/t/1/A', { info: { kind: 'none' }, failure: 'timeout' });
    w.onPath(edit('/w/A/.git/refs/heads/t1'));
    await settleAll();
    expect(h.interrogations).toEqual(['/t/1/A']);
    expect(h.openWatches()).toEqual([folderKey('/w/A/.git')]);
    expect(h.updates.some((u) => u.git !== undefined)).toBe(false);
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
    h.clear();
    h.git.set('/t/1/A', good);
    w.onPath(edit('/w/A/.git/worktrees/A/index'));
    await settleAll();
    expect(h.reads.map((r) => r.root)).toEqual(['/t/1/A']);
    expect(h.interrogations).toEqual(['/t/1/A']);
    expect(h.updates.some((u) => u.git !== undefined)).toBe(false);
  });

  it('lostFolders marks every repo under the folder (and every repo whose commonDir is under it) tree+meta', async () => {
    const h = harness();
    h.visible.add('s1');
    h.git.set('/x/wt', {
      info: { kind: 'branch', branch: 'wt', isWorktree: true, worktreeName: 'wt' },
      gitDir: '/w/A/.git/worktrees/wt',
      commonDir: '/w/A/.git',
    });
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home'), info('/x/wt'), info('/y/B')]);
    await settleAll();
    h.clear();
    h.tracker.lostFolders(['/w']);
    await settleAll();
    expect([...h.interrogations].sort()).toEqual(['/w/A', '/x/wt']);
    expect(h.reads.map((r) => r.root).sort()).toEqual(['/w/A', '/x/wt']);
  });

  it('own git-dir watch onLost marks all repos of that commonDir tree+meta', async () => {
    const h = harness();
    h.visible.add('s1');
    h.git.set('/x/wt', {
      info: { kind: 'branch', branch: 'wt', isWorktree: true, worktreeName: 'wt' },
      gitDir: '/w/A/.git/worktrees/wt',
      commonDir: '/w/A/.git',
    });
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home'), info('/x/wt'), info('/y/B')]);
    await settleAll();
    h.clear();
    const shared = h.watches.find((w) => w.dir === folderKey('/w/A/.git'));
    shared?.onLost();
    await settleAll();
    expect([...h.interrogations].sort()).toEqual(['/w/A', '/x/wt']);
    expect(h.reads.map((r) => r.root).sort()).toEqual(['/w/A', '/x/wt']);
  });

  it('covered→uncovered marks tree+meta; uncovered→covered marks tree', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setLiveRoots(['/w']);
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home'), info('/y/B')]);
    await settleAll();
    h.clear();
    h.tracker.setLiveRoots([]);
    await settleAll();
    expect(h.interrogations).toEqual(['/w/A']);
    expect(h.reads.map((r) => r.root)).toEqual(['/w/A']);
    h.clear();
    h.tracker.setLiveRoots(['/w']);
    await settleAll();
    expect(h.interrogations).toEqual([]);
    expect(h.reads.map((r) => r.root)).toEqual(['/w/A']);
    h.clear();
    h.tracker.setLiveRoots(['/w']);
    await settleAll();
    expect(h.reads).toEqual([]);
  });

  it('windowFocused: unknown commonDir → meta+tree immediate; refreshed > 30 s ago → tree at FOCUS_PRIORITY; fresh → nothing', async () => {
    expect(FOCUS_STALE_MS).toBe(30_000);
    expect(FOCUS_PRIORITY).toBeGreaterThan(0);
    const h = harness();
    h.visible.add('s1');
    h.git.set('/w/U', { info: { kind: 'none' } });
    h.tracker.setSessionRepos('s1', [info('/w/U', 'home'), info('/w/S'), info('/w/F')]);
    h.tracker.setSessionRepos('hidden', [info('/w/H')]);
    await settleAll();
    await flush(FOCUS_STALE_MS + 1);
    h.tracker.onWatchedPath(edit('/w/F/x.ts'));
    await settleAll();
    h.clear();
    h.tracker.windowFocused();
    await flush(0);
    expect(h.interrogations).toEqual(['/w/U']);
    expect(h.reads.map((r) => r.root)).toEqual(['/w/U']);
    await settleAll();
    expect(h.interrogations).toEqual(['/w/U']);
    expect(h.reads.map((r) => r.root)).toEqual(['/w/U', '/w/S']);
  });

  it('snapshotsFor marks pending repos stale; a completed publish never carries stale', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    expect(h.tracker.snapshotsFor('s1')['/w/A'].stale).toBeUndefined();
    h.tracker.onWatchedPath(edit('/w/A/x.ts'));
    expect(h.tracker.snapshotsFor('s1')['/w/A'].stale).toBe(true);
    await settleAll();
    expect(h.tracker.snapshotsFor('s1')['/w/A'].stale).toBeUndefined();
    h.visible.delete('s1');
    h.tracker.visibilityChanged();
    h.tracker.onWatchedPath(edit('/w/A/x.ts'));
    await settleAll();
    expect(h.tracker.snapshotsFor('s1')['/w/A'].stale).toBe(true);
    expect(h.updates.every((u) => u.snapshot?.stale === undefined)).toBe(true);
  });

  it('failure keeps last snapshot with error; next fire retries', async () => {
    const h = harness();
    h.visible.add('s1');
    h.readResult.set('/w/A', { ok: true, changes: [change('a.ts')], trackedDirty: true });
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    const good = h.tracker.snapshotsFor('s1')['/w/A'];
    h.clear();
    h.readResult.set('/w/A', { ok: false, reason: 'timeout' });
    await flush(5000);
    h.tracker.onWatchedPath(edit('/w/A/a.ts'));
    await settleAll();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].snapshot).toEqual({ ...good, error: 'timeout' });
    expect(h.updates[0].git).toBeUndefined();
    await flush(60_000);
    expect(h.reads).toHaveLength(1);
    h.readResult.set('/w/A', { ok: true, changes: [], trackedDirty: false });
    h.tracker.onWatchedPath(edit('/w/A/a.ts'));
    await settleAll();
    expect(h.updates[1].snapshot?.error).toBeUndefined();
    expect(h.updates[1].snapshot?.refreshedAt).toBeGreaterThan(good.refreshedAt);
  });

  it('a first read that fails still publishes an error snapshot', async () => {
    const h = harness();
    h.visible.add('s1');
    h.readResult.set('/w/A', { ok: false, reason: 'not-found' });
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    expect(h.tracker.snapshotsFor('s1')['/w/A']).toMatchObject({
      changes: [],
      error: 'not-found',
    });
  });

  it('git published only when fingerprint changes; tree run patches dirty from trackedDirty', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    expect(h.updates[0].git).toEqual({ kind: 'branch', branch: 'main', dirty: false });
    h.clear();
    h.tracker.onWatchedPath(edit('/w/A/x.ts'));
    await settleAll();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].git).toBeUndefined();
    h.clear();
    h.readResult.set('/w/A', { ok: true, changes: [change('x.ts')], trackedDirty: true });
    h.tracker.onWatchedPath(edit('/w/A/x.ts'));
    await settleAll();
    expect(h.updates[0].git).toEqual({ kind: 'branch', branch: 'main', dirty: true });
  });

  it('an unborn or non-repo interrogation never gains a dirty flag', async () => {
    const h = harness();
    h.visible.add('s1');
    h.git.set('/w/A', {
      info: { kind: 'branch', branch: 'main', unborn: true },
      gitDir: '/w/A/.git',
      commonDir: '/w/A/.git',
    });
    h.readResult.set('/w/A', { ok: true, changes: [change('x.ts')], trackedDirty: true });
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    expect(h.updates[0].git).toEqual({ kind: 'branch', branch: 'main', unborn: true });
  });

  it('first fill: home/attached before nested; nested by index mtime desc', async () => {
    const h = harness();
    h.visible.add('s1');
    const release = h.gateInterrogations();
    for (const [root, m] of [
      ['/w/n1', 10],
      ['/w/n2', 40],
      ['/w/n3', 30],
      ['/w/n4b', 20],
      ['/w/n4a', 20],
      ['/w/n5', 5],
    ] as const)
      h.mtimes.set(root, m);
    h.tracker.setSessionRepos('s1', [
      info('/w/n1'),
      info('/w/n2'),
      info('/w/n3'),
      info('/w/n4b'),
      info('/w/n4a'),
      info('/w/n5'),
      info('/w', 'home', '.'),
      info('/z/att', 'attached'),
    ]);
    await flush(0);
    release();
    await flush(10_000);
    expect(h.interrogations).toEqual([
      '/w',
      '/z/att',
      '/w/n2',
      '/w/n3',
      '/w/n4a',
      '/w/n4b',
      '/w/n1',
      '/w/n5',
    ]);
  });

  it('refreshNow on an unregistered root is a no-op', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.refreshNow('/w/nope');
    await settleAll();
    expect(h.reads).toEqual([]);
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    h.clear();
    h.tracker.refreshNow('/w/A');
    await flush(0);
    expect(h.interrogations).toEqual(['/w/A']);
    expect(h.reads.map((r) => r.root)).toEqual(['/w/A']);
  });

  it('stop closes own watches and runs nothing further', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A', 'home')]);
    await settleAll();
    h.clear();
    h.tracker.stop();
    expect(h.openWatches()).toEqual([]);
    h.tracker.onWatchedPath(edit('/w/A/x.ts'));
    h.tracker.refreshNow('/w/A');
    await settleAll();
    expect(h.reads).toEqual([]);
  });
});

describe('onDirty / reposUnder (file index invalidation)', () => {
  const dirtyLog = (h: ReturnType<typeof harness>) => {
    const seen: Array<string | null> = [];
    const off = h.tracker.onDirty((k) => seen.push(k));
    return { seen, off };
  };

  it('a loose path notifies null only', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A')]);
    await settleAll();
    const d = dirtyLog(h);
    h.tracker.onWatchedPath(edit('/w/notes.md'));
    expect(d.seen).toEqual([null]);
  });

  it('a repo edit notifies that key only; meta-only events notify nothing', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A'), info('/w/B')]);
    await settleAll();
    const d = dirtyLog(h);
    h.tracker.onWatchedPath(edit('/w/A/src/a.ts'));
    expect(d.seen).toEqual([folderKey('/w/A')]);
    d.seen.length = 0;
    h.tracker.onWatchedPath(edit('/w/A/.git/HEAD'));
    h.tracker.onWatchedPath(edit('/w/A/.git/refs/heads/main'));
    h.tracker.onWatchedPath(edit('/w/A/.git/objects/ab/cdef'));
    expect(d.seen).toEqual([]);
  });

  it('a hidden session still notifies (invalidation is not gated on visibility)', () => {
    const h = harness();
    h.tracker.setSessionRepos('bg', [info('/w/A')]);
    const d = dirtyLog(h);
    h.tracker.onWatchedPath(edit('/w/A/src/a.ts'));
    expect(d.seen).toEqual([folderKey('/w/A')]);
  });

  it('lostFolders notifies every repo under the folder, and null for its loose files', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A'), info('/y/B')]);
    await settleAll();
    const d = dirtyLog(h);
    h.tracker.lostFolders(['/w']);
    expect(d.seen).toEqual([folderKey('/w/A'), null]);
  });

  it('a root turning live notifies its newly covered repos and null', async () => {
    const h = harness();
    h.visible.add('s1');
    h.tracker.setSessionRepos('s1', [info('/w/A'), info('/y/B')]);
    await settleAll();
    const d = dirtyLog(h);
    h.tracker.setLiveRoots(['/w']);
    expect(d.seen).toEqual([folderKey('/w/A'), null]);
    d.seen.length = 0;
    h.tracker.setLiveRoots(['/w']);
    expect(d.seen).toEqual([]);
  });

  it('the returned function unsubscribes', () => {
    const h = harness();
    h.tracker.setSessionRepos('s1', [info('/w/A')]);
    const d = dirtyLog(h);
    d.off();
    h.tracker.onWatchedPath(edit('/w/A/src/a.ts'));
    h.tracker.onWatchedPath(edit('/w/notes.md'));
    expect(d.seen).toEqual([]);
  });

  it('reposUnder lists registered repos below a folder, sorted by key', () => {
    const h = harness();
    h.tracker.setSessionRepos('s1', [info('/w/B'), info('/w/A'), info('/w/A/sub'), info('/y/C')]);
    h.tracker.setSessionRepos('s2', [info('/w2/D')]);
    expect(h.tracker.reposUnder(folderKey('/w'))).toEqual([
      { key: folderKey('/w/A'), root: '/w/A' },
      { key: folderKey('/w/A/sub'), root: '/w/A/sub' },
      { key: folderKey('/w/B'), root: '/w/B' },
    ]);
    expect(h.tracker.reposUnder(folderKey('/w/A'))).toEqual([
      { key: folderKey('/w/A'), root: '/w/A' },
      { key: folderKey('/w/A/sub'), root: '/w/A/sub' },
    ]);
    expect(h.tracker.reposUnder(folderKey('/z'))).toEqual([]);
  });
});

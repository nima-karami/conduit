import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRepoTrackerHost } from '../../electron/repo-tracker-host';
import type { watchDirWhilePresent } from '../../electron/watch-dir';
import type { AppSessionView } from '../../src/contracts/server-protocol';
import type { HostToWebview } from '../../src/protocol';
import type { RepoInfo } from '../../src/repo-scan';
import { createSessionResourceDemand } from '../../src/session-resource-demand';

// Cross-module: the real demand drives the real host + tracker the way electron/main.ts wires
// them (spec 2026-11-03 demand-driven resources; plan Slice I1.2).

type Delta = Extract<HostToWebview, { type: 'repoDelta' }>;

const repo = (root: string): RepoInfo => ({ root, name: root, folder: root, tag: 'home' });

function harness() {
  const sessions = new Map<string, AppSessionView>();
  const sent: HostToWebview[] = [];
  const reads: Array<{ root: string; lines: boolean }> = [];
  const interrogations: string[] = [];
  const merges: string[] = [];
  const git = { branch: 'main' };
  const fakeWatch: typeof watchDirWhilePresent = () => ({ close() {} });
  let host: ReturnType<typeof createRepoTrackerHost> | undefined;
  const demand = createSessionResourceDemand(
    () => host?.tracker.visibilityChanged(),
    () => host?.tracker.visibilityChanged(),
  );
  host = createRepoTrackerHost({
    mgr: {
      get: (id: string) => sessions.get(id),
      list: () => [],
      mergeRepoGit: (patches) => merges.push(...patches.map((p) => p.sessionId)),
    },
    demand,
    owns: () => true,
    windows: () => [{ id: 1, send: (msg: HostToWebview) => sent.push(msg) }],
    log: { debug: vi.fn(), warn: vi.fn() },
    watchDirWhilePresent: fakeWatch,
    homeDir: '/home/u',
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
        interrogations.push(root);
        return {
          info: { kind: 'branch', branch: git.branch },
          gitDir: `${root}/.git`,
          commonDir: `${root}/.git`,
        };
      },
      indexMtime: async () => 0,
    },
  });
  const addSession = (id: string, root: string) => {
    sessions.set(id, {
      id,
      name: id,
      agentId: 'shell:cmd',
      home: root,
      roots: [],
      status: 'running',
      attentionReason: null,
      completions: 0,
      runtime: { generation: 1, spawn: 'live', reportedStatus: null, lastSize: null },
      createdAt: 0,
      lastActiveAt: 0,
      repos: [repo(root)],
    });
    host?.tracker.setSessionRepos(id, [repo(root)]);
  };
  const show = (ids: string[]) => {
    demand.setVisible(1, ids);
    host?.windowShown(1, ids);
  };
  const deltas = () => sent.filter((m): m is Delta => m.type === 'repoDelta');
  return {
    git,
    host: host as NonNullable<typeof host>,
    demand,
    sent,
    reads,
    interrogations,
    merges,
    addSession,
    show,
    deltas,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('hidden from start: no git status until shown; the first visible runs the catch-up', async () => {
  const h = harness();
  h.addSession('s1', '/w/a');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.reads).toEqual([]);
  h.show(['s1']);
  expect(h.deltas().some((d) => d.sessionId === 's1' && d.full)).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(h.reads).toEqual([{ root: '/w/a', lines: false }]);
  await vi.advanceTimersByTimeAsync(10);
  const snap = h.deltas().at(-1)?.repos['/w/a'];
  expect(snap).toMatchObject({ changes: [{ path: 'a.txt' }] });
  expect(snap && 'stale' in snap).toBe(false);
  h.host.tracker.stop();
});

it('turn end while hidden refreshes once with lines:false and publishes git without a send', async () => {
  const h = harness();
  h.addSession('s1', '/w/a');
  h.addSession('s2', '/w/b');
  h.show(['s2']);
  await vi.advanceTimersByTimeAsync(15_000);
  const readsBefore = h.reads.length;
  const sentBefore = h.deltas().filter((d) => d.sessionId === 's1').length;
  const mergesBefore = h.merges.filter((id) => id === 's1').length;
  // The agent's turn committed on a new branch; only a refresh can publish it.
  h.git.branch = 'feature';
  h.host.tracker.sessionTurnEnded('s1');
  h.host.tracker.sessionTurnEnded('s1');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.reads.slice(readsBefore)).toEqual([{ root: '/w/a', lines: false }]);
  expect(h.deltas().filter((d) => d.sessionId === 's1')).toHaveLength(sentBefore);
  expect(h.merges.filter((id) => id === 's1').length).toBeGreaterThan(mergesBefore);
  h.host.tracker.stop();
});

it('minimize then restore: no run while minimized; restore sends full and runs once', async () => {
  const h = harness();
  h.addSession('s1', '/w/a');
  h.show(['s1']);
  await vi.advanceTimersByTimeAsync(15_000);
  h.demand.setSuspended(1, true);
  const readsBefore = h.reads.length;
  h.host.tracker.onWatchedPath('/w/a/x.txt');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.reads.length).toBe(readsBefore);
  const fullsBefore = h.deltas().filter((d) => d.full).length;
  h.demand.setSuspended(1, false);
  h.host.windowRestored(1);
  expect(h.deltas().filter((d) => d.full).length).toBe(fullsBefore + 1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.reads.length).toBe(readsBefore + 1);
  h.host.tracker.stop();
});

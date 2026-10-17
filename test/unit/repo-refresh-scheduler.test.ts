import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRefreshScheduler,
  type PendingKinds,
  REFRESH_CONCURRENCY,
  REFRESH_COOLDOWN_MS,
  REFRESH_SETTLE_MS,
  type RefreshSchedulerDeps,
} from '../../src/repo-refresh-scheduler';

interface Run {
  key: string;
  kinds: PendingKinds;
  at: number;
  settled: boolean;
  resolve(): void;
  reject(e: unknown): void;
}

function harness(opts: { autoMs?: number; eligible?: (key: string) => boolean } = {}) {
  const runs: Run[] = [];
  let active = 0;
  let peak = 0;
  const deps: RefreshSchedulerDeps = {
    run: (key, kinds) =>
      new Promise<void>((resolve, reject) => {
        active++;
        peak = Math.max(peak, active);
        const run: Run = {
          key,
          kinds,
          at: Date.now(),
          settled: false,
          resolve: () => {
            if (run.settled) return;
            run.settled = true;
            active--;
            resolve();
          },
          reject: (e) => {
            run.settled = true;
            active--;
            reject(e);
          },
        };
        runs.push(run);
        if (opts.autoMs !== undefined) setTimeout(run.resolve, opts.autoMs);
      }),
    eligible: opts.eligible ?? (() => true),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const s = createRefreshScheduler(deps);
  return { s, runs, peak: () => peak, active: () => active };
}

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createRefreshScheduler', () => {
  it('pins the locked tuning', () => {
    expect([REFRESH_SETTLE_MS, REFRESH_COOLDOWN_MS, REFRESH_CONCURRENCY]).toEqual([300, 800, 4]);
  });

  it('the stress lane mirrors the cooldown its status caps derive from', () => {
    const harness = readFileSync(
      join(__dirname, '..', 'e2e', 'stress', 'multi-repo-harness.mjs'),
      'utf8',
    );
    expect(harness).toContain(`export const REFRESH_COOLDOWN_MS = ${REFRESH_COOLDOWN_MS};`);
  });

  it('a burst of marks runs once after settle', async () => {
    const { s, runs } = harness();
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      s.mark('a', 'tree');
      await settle(4);
    }
    await settle(299 - (Date.now() - t0));
    expect(runs).toHaveLength(0);
    await settle(1);
    expect(runs.map((r) => [r.key, r.at - t0])).toEqual([['a', 300]]);
  });

  it('marks OR into pending kinds', async () => {
    const { s, runs } = harness();
    s.mark('a', 'tree');
    s.mark('a', 'meta');
    await settle(300);
    expect(runs[0].kinds).toEqual({ meta: true, tree: true });
  });

  it('continuous marks run at most once per cooldown with a trailing run', async () => {
    const { s, runs } = harness({ autoMs: 50 });
    const t0 = Date.now();
    let lastMark = 0;
    const markMs = 3000;
    for (let t = 0; t <= markMs; t += 100) {
      s.mark('a', 'tree');
      lastMark = Date.now() - t0;
      await settle(100);
    }
    await settle(5000);
    const starts = runs.map((r) => r.at - t0);
    // First run at settle, one per cooldown while marks last, then the trailing run.
    const maxRuns = Math.ceil((markMs - REFRESH_SETTLE_MS) / REFRESH_COOLDOWN_MS) + 1;
    expect(starts.length).toBeLessThanOrEqual(maxRuns);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(REFRESH_COOLDOWN_MS);
    expect(starts[starts.length - 1]).toBeGreaterThan(lastMark);
  });

  it('one in flight per key', async () => {
    const { s, runs } = harness();
    s.mark('a', 'tree', { immediate: true });
    await settle();
    expect(runs).toHaveLength(1);
    s.mark('a', 'meta', { immediate: true });
    await settle(5000);
    expect(runs).toHaveLength(1);
    runs[0].resolve();
    await settle();
    expect(runs).toHaveLength(2);
    expect(runs[1].kinds).toEqual({ meta: true, tree: false });
  });

  it('a trailing run after a non-immediate mark waits out the cooldown', async () => {
    const { s, runs } = harness();
    const t0 = Date.now();
    s.mark('a', 'tree', { immediate: true });
    await settle();
    s.mark('a', 'tree');
    await settle(10);
    runs[0].resolve();
    await settle(REFRESH_COOLDOWN_MS - 11);
    expect(runs).toHaveLength(1);
    await settle(1);
    expect(runs.map((r) => r.at - t0)).toEqual([0, REFRESH_COOLDOWN_MS]);
  });

  it('host-wide cap of 4', async () => {
    const { s, runs, peak, active } = harness();
    for (let i = 0; i < 10; i++) s.mark(`k${i}`, 'tree', { immediate: true });
    await settle();
    expect(active()).toBe(REFRESH_CONCURRENCY);
    runs[0].resolve();
    await settle();
    expect(runs).toHaveLength(REFRESH_CONCURRENCY + 1);
    for (let wave = 0; wave < 4; wave++) {
      for (const r of runs) r.resolve();
      await settle();
    }
    expect(new Set(runs.map((r) => r.key)).size).toBe(10);
    expect(peak()).toBe(REFRESH_CONCURRENCY);
  });

  it('priority orders ready jobs', async () => {
    const { s, runs } = harness();
    for (let i = 0; i < REFRESH_CONCURRENCY; i++) s.mark(`busy${i}`, 'tree', { immediate: true });
    await settle();
    s.mark('late', 'tree', { immediate: true, priority: 5 });
    s.mark('first', 'tree', { immediate: true, priority: 1 });
    s.mark('mid', 'tree', { immediate: true, priority: 3 });
    s.mark('tie', 'tree', { immediate: true, priority: 3 });
    await settle();
    for (let i = 0; i < 4; i++) {
      runs[i].resolve();
      await settle();
    }
    expect(runs.slice(REFRESH_CONCURRENCY).map((r) => r.key)).toEqual([
      'first',
      'mid',
      'tie',
      'late',
    ]);
  });

  it('ineligible key parks with no run; reconsider runs it', async () => {
    let visible = false;
    const { s, runs } = harness({ eligible: () => visible });
    s.mark('a', 'tree', { immediate: true });
    s.mark('a', 'meta');
    await settle(60_000);
    expect(runs).toHaveLength(0);
    s.reconsider();
    await settle(60_000);
    expect(runs).toHaveLength(0);
    visible = true;
    s.reconsider();
    await settle();
    expect(runs).toHaveLength(1);
    expect(runs[0].kinds).toEqual({ meta: true, tree: true });
    runs[0].resolve();
    s.reconsider();
    await settle(60_000);
    expect(runs).toHaveLength(1);
  });

  it('immediate skips settle and cooldown', async () => {
    const { s, runs } = harness();
    const t0 = Date.now();
    s.mark('a', 'tree', { immediate: true });
    await settle();
    runs[0].resolve();
    await settle(10);
    s.mark('a', 'tree', { immediate: true });
    await settle();
    expect(runs.map((r) => r.at - t0)).toEqual([0, 10]);
  });

  it('an immediate mark upgrades a pending settle timer', async () => {
    const { s, runs } = harness();
    const t0 = Date.now();
    s.mark('a', 'tree');
    await settle(50);
    s.mark('a', 'meta', { immediate: true });
    await settle();
    expect(runs.map((r) => [r.at - t0, r.kinds])).toEqual([[50, { meta: true, tree: true }]]);
    await settle(5000);
    expect(runs).toHaveLength(1);
  });

  it('forget drops pending and ignores a late completion', async () => {
    const { s, runs } = harness();
    s.mark('gone', 'tree');
    s.forget('gone');
    await settle(5000);
    expect(runs).toHaveLength(0);

    s.mark('a', 'tree', { immediate: true });
    await settle();
    s.mark('a', 'tree');
    s.forget('a');
    runs[0].resolve();
    await settle(5000);
    expect(runs).toHaveLength(1);

    for (let i = 0; i < REFRESH_CONCURRENCY; i++) s.mark(`k${i}`, 'tree', { immediate: true });
    await settle();
    expect(runs).toHaveLength(1 + REFRESH_CONCURRENCY);
  });

  it('a key forgotten and re-marked mid-run still never runs twice at once', async () => {
    const { s, runs } = harness();
    s.mark('a', 'tree', { immediate: true });
    await settle();
    s.forget('a');
    s.mark('a', 'meta', { immediate: true });
    await settle(5000);
    expect(runs).toHaveLength(1);
    runs[0].resolve();
    await settle();
    expect(runs.map((r) => r.kinds)).toEqual([
      { meta: false, tree: true },
      { meta: true, tree: false },
    ]);
  });

  it('a rejected run does not wedge the key', async () => {
    const { s, runs } = harness();
    s.mark('a', 'tree', { immediate: true });
    await settle();
    runs[0].reject(new Error('boom'));
    await settle();
    s.mark('a', 'tree', { immediate: true });
    await settle();
    expect(runs).toHaveLength(2);
  });

  it('stop cancels timers and queued work', async () => {
    const { s, runs } = harness();
    s.mark('a', 'tree');
    s.stop();
    await settle(5000);
    s.mark('b', 'tree', { immediate: true });
    await settle(5000);
    expect(runs).toHaveLength(0);
  });
});

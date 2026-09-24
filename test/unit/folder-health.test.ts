import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyHealthReport,
  type Bounded,
  FolderHealth,
  type FolderHealthReport,
} from '../../src/folder-health';
import { folderKey } from '../../src/folder-key';
import type { Session } from '../../src/types';

function session(id: string, home: string, roots: string[] = []): Session {
  return {
    id,
    name: id,
    agentId: 'claude',
    home,
    roots,
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

/**
 * `isDir` answers from `auto` at once; any other path hangs until `settle(p, ok)`. Reports are
 * applied to the fake sessions the way the runtime does (no rejected roots).
 */
function harness(
  sessions: Session[],
  opts: {
    auto?: Record<string, boolean>;
    maxInFlight?: number;
    applyWork?: (bounded: Bounded) => Promise<unknown>;
  } = {},
) {
  const issued: string[] = [];
  const hanging = new Map<string, ((ok: boolean) => void)[]>();
  let outstanding = 0;
  let maxOutstanding = 0;
  const reports: FolderHealthReport[] = [];
  const health = new FolderHealth({
    isDir: (p) => {
      issued.push(p);
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      const done = <T>(v: T) => {
        outstanding--;
        return v;
      };
      const auto = opts.auto?.[p];
      if (auto !== undefined) return Promise.resolve(auto).then(done);
      return new Promise<boolean>((r) => hanging.set(p, [...(hanging.get(p) ?? []), r])).then(done);
    },
    get: (id) => sessions.find((s) => s.id === id),
    sessions: () => sessions,
    apply: async (r, bounded) => {
      reports.push(r);
      await opts.applyWork?.(bounded);
      const s = sessions.find((x) => x.id === r.sessionId);
      if (!s) return;
      const h = applyHealthReport(s, r, new Set());
      if (h.missingRoots.length > 0) s.missingRoots = h.missingRoots;
      else delete s.missingRoots;
      if (r.homeKey !== folderKey(s.home)) return;
      if (h.homeMissing) s.homeMissing = true;
      else delete s.homeMissing;
    },
    maxInFlight: opts.maxInFlight,
  });
  const settle = (p: string, ok: boolean) => {
    const q = hanging.get(p) ?? [];
    hanging.set(p, q.slice(1));
    q[0]?.(ok);
  };
  return {
    health,
    issued,
    reports,
    settle,
    maxOutstanding: () => maxOutstanding,
    tick: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

const states = (r: FolderHealthReport | undefined) => Object.fromEntries(r?.states ?? []);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FolderHealth', () => {
  it('one isDir in flight per key across sessions', async () => {
    const a = session('a', '/w/a', ['C:/x/shared']);
    const b = session('b', '/w/b', ['c:/x/shared/']);
    const h = harness([a, b], { auto: { '/w/a': true, '/w/b': true }, maxInFlight: 10 });
    const done = Promise.all([h.health.check('a'), h.health.check('b')]);
    await h.tick(0);
    expect(h.issued.filter((p) => p.toLowerCase().startsWith('c:/x/shared'))).toHaveLength(1);
    h.settle('C:/x/shared', true);
    await h.tick(0);
    await done;
    expect(states(h.reports.find((r) => r.sessionId === 'b'))['c:/x/shared']).toBe('present');
    expect(states(h.reports.find((r) => r.sessionId === 'a'))['c:/x/shared']).toBe('present');
  });

  it('never more than 2 outstanding across keys (S3)', async () => {
    const a = session('a', '/w/a', ['/x/1', '/x/2', '/x/3', '/x/4']);
    const h = harness([a]);
    const done = h.health.check('a');
    await h.tick(0);
    expect(h.issued).toEqual(['/w/a', '/x/1']);
    h.settle('/w/a', true);
    await h.tick(0);
    expect(h.issued).toEqual(['/w/a', '/x/1', '/x/2']);
    for (const p of ['/x/1', '/x/2', '/x/3', '/x/4']) {
      h.settle(p, true);
      await h.tick(0);
    }
    await done;
    expect(h.maxOutstanding()).toBe(2);
    expect(Object.values(states(h.reports[0]))).toEqual(Array(5).fill('present'));
  });

  it('hung stat → missing at 3 s from issue; not re-issued by the poll while unsettled', async () => {
    const a = session('a', '/w/a', ['/x/hung']);
    const h = harness([a], { maxInFlight: 1 });
    void h.health.check('a');
    await h.tick(1000);
    h.settle('/w/a', true);
    await h.tick(0);
    expect(h.issued).toEqual(['/w/a', '/x/hung']);
    await h.tick(2999);
    expect(h.reports).toHaveLength(0);
    await h.tick(1);
    expect(states(h.reports[0])).toEqual({ '/w/a': 'present', '/x/hung': 'missing' });
    expect(a.missingRoots).toEqual(['/x/hung']);

    await h.tick(5000);
    expect(h.issued).toEqual(['/w/a', '/x/hung']);
    expect(h.reports).toHaveLength(2);
    expect(states(h.reports[1])).toEqual({ '/x/hung': 'missing' });

    h.settle('/x/hung', true);
    await h.tick(5000);
    expect(h.issued).toEqual(['/w/a', '/x/hung', '/x/hung']);
  });

  it('queued past its window → unknown, previous state kept', async () => {
    const a = session('a', '/w/a', ['/x/h1']);
    const b = session('b', '/w/b', ['/x/q']);
    b.missingRoots = ['/x/q'];
    const h = harness([a, b]);
    void h.health.check('a');
    await h.tick(1000);
    const done = h.health.check('b');
    await h.tick(2999);
    expect(h.issued).toEqual(['/w/a', '/x/h1']);
    await h.tick(1);
    await done;
    expect(states(h.reports.find((r) => r.sessionId === 'b'))).toEqual({
      '/w/b': 'unknown',
      '/x/q': 'unknown',
    });
    expect(b.missingRoots).toEqual(['/x/q']);
    expect('homeMissing' in b).toBe(false);
  });

  it('poll starts when a home or a root is missing, stops when none', async () => {
    const a = session('a', '/w/a', ['/x/r']);
    const h = harness([a], { auto: { '/x/r': true } });
    const first = h.health.check('a');
    await h.tick(0);
    h.settle('/w/a', true);
    await first;
    expect(vi.getTimerCount()).toBe(0);

    const second = h.health.check('a');
    await h.tick(0);
    h.settle('/w/a', false);
    await second;
    expect(a.homeMissing).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await h.tick(5000);
    expect(h.issued.at(-1)).toBe('/w/a');
    h.settle('/w/a', true);
    await h.tick(0);
    expect('homeMissing' in a).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await h.tick(20000);
    expect(h.issued).toHaveLength(5);
  });

  it('tick re-stats only missing folders', async () => {
    const a = session('a', '/w/a', ['/x/ok', '/x/gone']);
    const b = session('b', '/w/b');
    const h = harness([a, b], {
      auto: { '/w/a': true, '/x/ok': true, '/x/gone': false, '/w/b': true },
    });
    await h.health.check('a');
    await h.health.check('b');
    expect(a.missingRoots).toEqual(['/x/gone']);
    h.issued.length = 0;
    await h.tick(5000);
    expect(h.issued).toEqual(['/x/gone']);
    await h.tick(5000);
    expect(h.issued).toEqual(['/x/gone', '/x/gone']);
  });

  it('check(id, only) stats just those', async () => {
    const a = session('a', '/w/a', ['/x/one', '/x/two']);
    const h = harness([a], { auto: { '/x/two': true } });
    await h.health.check('a', ['/x/two/', '/elsewhere']);
    expect(h.issued).toEqual(['/x/two']);
    expect(states(h.reports[0])).toEqual({ '/x/two': 'present' });
    await h.health.check('a', ['/elsewhere']);
    await h.health.check('nope');
    expect(h.issued).toEqual(['/x/two']);
    expect(h.reports).toHaveLength(1);
  });

  it('report carries the homeKey measured', async () => {
    const a = session('a', 'C:/w/Old');
    const h = harness([a]);
    const done = h.health.check('a');
    await h.tick(0);
    a.home = 'C:/w/new';
    h.settle('C:/w/Old', false);
    await done;
    expect(h.reports[0].homeKey).toBe('c:/w/old');
    expect('homeMissing' in a).toBe(false);
  });

  it('pending() covers the check through its apply', async () => {
    const a = session('a', '/w/a');
    const h = harness([a]);
    expect(h.health.pending('a')).toBeUndefined();
    void h.health.check('a');
    const pending = h.health.pending('a');
    let settled = false;
    void pending?.then(() => (settled = true));
    await h.tick(0);
    expect(settled).toBe(false);
    h.settle('/w/a', true);
    await h.tick(0);
    expect(settled).toBe(true);
    expect(h.reports).toHaveLength(1);
    expect(h.health.pending('a')).toBeUndefined();
  });

  it('apply fs work is timed: a hung one frees pending() at the timeout (F4)', async () => {
    let got: unknown = 'unset';
    const h = harness([session('a', '/w/a')], {
      auto: { '/w/a': true },
      applyWork: async (bounded) => {
        got = await bounded(() => new Promise(() => {}));
      },
    });
    void h.health.check('a');
    let settled = false;
    void h.health.pending('a')?.then(() => {
      settled = true;
    });
    await h.tick(2990);
    expect(settled).toBe(false);
    await h.tick(20);
    expect(settled).toBe(true);
    expect(got).toBeUndefined();
  });

  it('apply fs work holds a stat slot, so it counts against the cap (S3)', async () => {
    const h = harness([session('a', '/w/a'), session('b', '/w/b')], {
      auto: { '/w/a': true },
      maxInFlight: 1,
      applyWork: (bounded) => bounded(() => new Promise(() => {})),
    });
    void h.health.check('a');
    await h.tick(0);
    void h.health.check('b');
    await h.tick(0);
    expect(h.issued).toEqual(['/w/a']);
  });

  it('dispose stops the poll and drops later results', async () => {
    const a = session('a', '/w/a', ['/x/slow']);
    a.homeMissing = true;
    const h = harness([a], { auto: { '/w/a': false, '/x/slow': true } });
    await h.health.check('a', ['/w/a']);
    expect(vi.getTimerCount()).toBe(1);
    const inFlight = h.health.check('a', ['/x/slow']);
    h.health.dispose();
    await inFlight;
    expect(vi.getTimerCount()).toBe(0);
    await h.health.check('a');
    expect(h.reports).toHaveLength(1);
  });
});

describe('applyHealthReport', () => {
  const report = (homeKey: string, s: Record<string, 'present' | 'missing' | 'unknown'>) => ({
    sessionId: 'a',
    homeKey,
    states: new Map(Object.entries(s)),
  });

  it('present clears unless rejected', () => {
    const s = { ...session('a', '/w/a', ['/x/1', '/x/2', '/x/3']), missingRoots: ['/x/1', '/x/2'] };
    const r = report('/w/a', { '/x/1': 'present', '/x/2': 'present', '/x/3': 'missing' });
    expect(applyHealthReport(s, r, new Set(['/x/2']))).toEqual({
      homeKey: '/w/a',
      missingRoots: ['/x/2', '/x/3'],
      homeMissing: false,
    });
  });

  it('a present home that failed revalidation stays missing (spec §2.6)', () => {
    const s = { ...session('a', '/w/a', ['/x/1']), homeMissing: true };
    const r = report('/w/a', { '/w/a': 'present', '/x/1': 'present' });
    expect(applyHealthReport(s, r, new Set(['/w/a']))).toEqual({
      homeKey: '/w/a',
      missingRoots: [],
      homeMissing: true,
    });
  });

  it('unknown keeps', () => {
    const s = {
      ...session('a', '/w/a', ['/x/1', '/x/2']),
      missingRoots: ['/x/1'],
      homeMissing: true,
    };
    const r = report('/w/a', { '/w/a': 'unknown', '/x/1': 'unknown', '/x/2': 'unknown' });
    expect(applyHealthReport(s, r, new Set())).toEqual({
      homeKey: '/w/a',
      missingRoots: ['/x/1'],
      homeMissing: true,
    });
  });

  it('home applied only for the matching homeKey (S2)', () => {
    const s = session('a', 'C:/w/New', ['C:/w/old']);
    expect(applyHealthReport(s, report('c:/w/old', { 'c:/w/old': 'missing' }), new Set())).toEqual({
      homeKey: 'c:/w/old',
      missingRoots: ['C:/w/old'],
      homeMissing: false,
    });
    expect(applyHealthReport(s, report('c:/w/new', { 'c:/w/new': 'missing' }), new Set())).toEqual({
      homeKey: 'c:/w/new',
      missingRoots: [],
      homeMissing: true,
    });
  });
});

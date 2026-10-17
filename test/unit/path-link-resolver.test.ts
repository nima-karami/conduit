import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPathLinkResolver,
  MAX_TOKENS,
  PARKED_IO_MS,
  type PathLinkResolverDeps,
  RESOLVE_CONCURRENCY,
  STAT_CONCURRENCY,
  UNC_PROBE_BUDGET_MS,
} from '../../electron/path-link-resolver';
import type { IndexedFile } from '../../src/path-resolve';
import type { RepoInfo } from '../../src/repo-scan';
import type { Session } from '../../src/types';

afterEach(() => vi.useRealTimers());

const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'] });

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    name: 's',
    agentId: 'shell:cmd',
    home: '/w',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...over,
  }) as Session;

const repo = (root: string, tag: RepoInfo['tag'] = 'nested'): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder: '/w',
  tag,
});

interface Fake {
  sessions: Record<string, Session>;
  files?: string[];
  index?: Record<string, { files: IndexedFile[]; coveredRoots: string[] } | 'reject'>;
  gitRoot?: string | ((s: Session) => Promise<string>);
  fileIndex?: PathLinkResolverDeps['fileIndex'];
  stat?: PathLinkResolverDeps['stat'];
  /** realPathLeaf mapping; identity otherwise. */
  real?: Record<string, string>;
  dirs?: string[];
  platform?: PathLinkResolverDeps['platform'];
  caseSensitive?: boolean;
}

function make(f: Fake) {
  const fs = new Set(f.files ?? []);
  const statCalls: string[] = [];
  const indexCalls: string[] = [];
  const topLevelCalls: string[] = [];
  const warns: Array<{ scope: string; msg: string; data?: Record<string, unknown> }> = [];
  const debugs: Array<{ scope: string; msg: string; data?: Record<string, unknown> }> = [];
  const realCalls: string[] = [];
  const dirs = new Set(f.dirs ?? []);
  const deps: PathLinkResolverDeps = {
    getSession: (id) => f.sessions[id],
    gitRoot: async (s) =>
      typeof f.gitRoot === 'function' ? f.gitRoot(s) : (f.gitRoot ?? s.cwd ?? s.home),
    fileIndex: async (root) => {
      indexCalls.push(root);
      if (f.fileIndex) return f.fileIndex(root);
      const ix = f.index?.[root];
      if (ix === 'reject') throw new Error('index failed');
      return ix ?? { files: [], coveredRoots: [] };
    },
    stat:
      f.stat ??
      (async (abs) => {
        statCalls.push(abs);
        return fs.has(abs) ? 'file' : dirs.has(abs) ? 'dir' : null;
      }),
    realPathLeaf: (t) => {
      realCalls.push(t);
      return f.real?.[t] ?? t;
    },
    topLevel: async (dir) => {
      topLevelCalls.push(dir);
      return '';
    },
    homeDir: '/home/u',
    platform: f.platform ?? 'posix',
    caseSensitive: f.caseSensitive ?? true,
    log: {
      warn: (scope, msg, data) => warns.push({ scope, msg, data }),
      debug: (scope, msg, data) => debugs.push({ scope, msg, data }),
    },
  };
  return {
    resolver: createPathLinkResolver(deps),
    statCalls,
    indexCalls,
    topLevelCalls,
    warns,
    debugs,
    realCalls,
  };
}

const W_FILES = ['/w/repoA/src/index.ts', '/w/repoB/src/index.ts'];
const wIndex = {
  '/w': {
    files: W_FILES.map((abs) => ({ rel: abs.slice(3), abs })),
    coveredRoots: ['/w/repoA'],
  },
};
const wSession = session({ repos: [repo('/w/repoA'), repo('/w/repoB')] });

describe('createPathLinkResolver', () => {
  it('unknown session → one session-gone result per entry', async () => {
    const { resolver } = make({ sessions: {} });
    const reply = await resolver.resolve('nope', [{ alts: ['a.ts'] }, { alts: ['b', 'c'] }]);
    expect(reply).toEqual({
      cwd: '',
      rootsSig: '',
      roots: [],
      results: [
        { key: 'a.ts', candidates: [], truncated: false, total: 0, error: 'session-gone' },
        { key: 'b\0c', candidates: [], truncated: false, total: 0, error: 'session-gone' },
      ],
    });
  });

  describe('per-token validation', () => {
    it(`more than MAX_TOKENS entries → only the first ${MAX_TOKENS} get results`, async () => {
      const { resolver } = make({ sessions: { s1: wSession } });
      const tokens = Array.from({ length: MAX_TOKENS + 1 }, (_, i) => ({ alts: [`f${i}.ts`] }));
      const reply = await resolver.resolve('s1', tokens);
      expect(reply.results.map((r) => r.key)).toEqual(
        tokens.slice(0, MAX_TOKENS).map((t) => t.alts[0]),
      );
    });

    it('a malformed entry is invalid while its neighbours resolve', async () => {
      const { resolver } = make({ sessions: { s1: wSession }, files: ['/w/a.ts', '/w/c.ts'] });
      const reply = await resolver.resolve('s1', [
        { alts: ['a.ts'] },
        { alts: 5 },
        { alts: ['c.ts'] },
        {},
        { alts: [] },
        'x',
      ]);
      expect(reply.results.map((r) => [r.key, r.error, r.candidates.length])).toEqual([
        ['a.ts', undefined, 1],
        ['', 'invalid', 0],
        ['c.ts', undefined, 1],
        ['', 'invalid', 0],
        ['', 'invalid', 0],
        ['', 'invalid', 0],
      ]);
    });

    it('only the first 4 alts are tried, and a trimmed entry keeps its ORIGINAL key', async () => {
      const { resolver, statCalls } = make({ sessions: { s1: session() } });
      const alts = ['a', 'b', 'c', 'd', 'e'];
      const [r] = (await resolver.resolve('s1', [{ alts }])).results;
      expect(r.key).toBe('a\0b\0c\0d\0e');
      expect(statCalls).toEqual(['/w/a', '/w/b', '/w/c', '/w/d']);
    });

    it('an alt over 1024 chars is dropped, the others kept, the key unchanged', async () => {
      const { resolver, statCalls } = make({ sessions: { s1: session() } });
      const long = 'x'.repeat(1025);
      const [r] = (await resolver.resolve('s1', [{ alts: [long, 'ok'] }])).results;
      expect(r.key).toBe(`${long}\0ok`);
      expect(statCalls).toEqual(['/w/ok']);
      const [gone] = (await resolver.resolve('s1', [{ alts: [long] }])).results;
      expect(gone).toMatchObject({ key: long, error: 'invalid' });
    });

    it("res.alt indexes the renderer's alts, not the host's trimmed list", async () => {
      const { resolver } = make({ sessions: { s1: session() }, files: ['/w/ok'] });
      const long = 'x'.repeat(1025);
      const [two] = (await resolver.resolve('s1', [{ alts: [long, 'miss', 'ok'] }])).results;
      expect(two.alt).toBe(2);
      const [one] = (await resolver.resolve('s1', [{ alts: [long, 'ok'] }])).results;
      expect(one.alt).toBe(1);
      const [zero] = (await resolver.resolve('s1', [{ alts: ['ok', long] }])).results;
      expect(zero.alt).toBeUndefined();
    });

    it('a non-array `tokens` → results []', async () => {
      const { resolver } = make({ sessions: { s1: session() } });
      expect((await resolver.resolve('s1', 'nope')).results).toEqual([]);
      expect((await resolver.resolve('s1', undefined)).results).toEqual([]);
    });
  });

  it('a UNC stat that never settles is a miss after the budget, without delaying a local token', async () => {
    vi.useFakeTimers();
    const unc = session({ home: '//srv/share', cwd: '//srv/share' });
    const { resolver } = make({
      sessions: { s1: unc },
      stat: (abs) =>
        abs.startsWith('//')
          ? new Promise(() => {})
          : Promise.resolve(abs === '/abs/x.ts' ? 'file' : null),
    });
    let done = false;
    const reply = resolver
      .resolve('s1', [{ alts: ['a.ts'] }, { alts: ['/abs/x.ts'] }])
      .then((r) => {
        done = true;
        return r;
      });
    await vi.advanceTimersByTimeAsync(UNC_PROBE_BUDGET_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { results } = await reply;
    expect(results[0].candidates).toHaveLength(0);
    expect(results[1].candidates.map((c) => c.absPath)).toEqual(['/abs/x.ts']);
  });

  it('a cwd moved outside every user root is not a UNC root: nothing linked, 0 stats', async () => {
    const s = session({ home: 'G:/w', cwd: '//evil/share/repo' });
    const { resolver, statCalls } = make({ sessions: { s1: s }, gitRoot: '//evil/share/repo' });
    const { results } = await resolver.resolve('s1', [
      { alts: ['//evil/share/repo/a.ts'] },
      { alts: ['a.ts'] },
    ]);
    expect(results.map((r) => r.candidates.length)).toEqual([0, 0]);
    expect(statCalls.filter((p) => p.startsWith('//'))).toEqual([]);
  });

  it(`never more than ${STAT_CONCURRENCY} stats in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const roots = Array.from({ length: 30 }, (_, i) => `/r${i}`);
    const { resolver } = make({
      sessions: { s1: session({ roots }) },
      stat: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return null;
      },
    });
    await resolver.resolve(
      's1',
      Array.from({ length: 10 }, (_, i) => ({ alts: [`f${i}.ts`] })),
    );
    expect(peak).toBe(STAT_CONCURRENCY);
  });

  it('indexes the cwd root plus each attached root, never nested repos', async () => {
    const s = session({ roots: ['/att'], repos: [repo('/w/repoA'), repo('/att', 'attached')] });
    const { resolver, indexCalls } = make({ sessions: { s1: s } });
    await resolver.resolve('s1', [{ alts: ['x.ts'] }]);
    expect(indexCalls.sort()).toEqual(['/att', '/w']);
  });

  it('coveredRoots → coveredRootIdx: a covered nested repo answers by membership, an uncovered one is stat’ed', async () => {
    const { resolver, statCalls } = make({
      sessions: { s1: wSession },
      files: W_FILES,
      index: wIndex,
    });
    const { results, roots } = await resolver.resolve('s1', [{ alts: ['src/index.ts'] }]);
    expect(results[0].candidates.map((c) => roots[c.rootIdx].abs)).toEqual([
      '/w/repoA',
      '/w/repoB',
    ]);
    expect(statCalls).not.toContain('/w/repoA/src/index.ts');
    expect(statCalls).toContain('/w/repoB/src/index.ts');
  });

  it('a fileIndex rejection is logged, then degrades to exact-only: every root is stat’ed, no throw', async () => {
    const { resolver, statCalls, warns } = make({
      sessions: { s1: wSession },
      files: W_FILES,
      index: { '/w': 'reject' },
    });
    const { results } = await resolver.resolve('s1', [{ alts: ['src/index.ts'] }]);
    expect(results[0].candidates).toHaveLength(2);
    expect(statCalls).toEqual(
      expect.arrayContaining(['/w/repoA/src/index.ts', '/w/repoB/src/index.ts']),
    );
    expect(warns).toEqual([
      { scope: 'links', msg: 'index-failed', data: { root: '/w', error: 'Error: index failed' } },
    ]);
  });

  it('hands the event loop a turn between tokens', async () => {
    const events: string[] = [];
    const { resolver } = make({
      sessions: { s1: wSession },
      stat: async (abs) => {
        if (events.length === 0) setImmediate(() => events.push('tick'));
        events.push(`stat ${abs}`);
        return null;
      },
    });
    await resolver.resolve('s1', [{ alts: ['/a.ts'] }, { alts: ['/b.ts'] }]);
    expect(events).toEqual(['stat /a.ts', 'tick', 'stat /b.ts']);
  });

  it(`never more than ${RESOLVE_CONCURRENCY} resolves mid-slice; the rest queue and all answer`, async () => {
    // From a resolve's first token to its second spans the yielded turn between them: only a
    // resolve holding a slot can be inside that span. A local stat takes a few ms, short of
    // PARKED_IO_MS, so it must not hand the slot on (review r2 stress).
    fakeTimers();
    let inFlight = 0;
    let peak = 0;
    const { resolver } = make({
      sessions: { s1: wSession },
      stat: async (abs) => {
        if (abs.endsWith('/a.ts')) inFlight++;
        if (abs.endsWith('/b.ts')) inFlight--;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        return null;
      },
    });
    const all = Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        resolver.resolve('s1', [{ alts: [`/r${i}/a.ts`] }, { alts: [`/r${i}/b.ts`] }]),
      ),
    );
    await vi.runAllTimersAsync();
    expect(await all).toHaveLength(6);
    expect(peak).toBe(RESOLVE_CONCURRENCY);
  });

  it(`resolves that let the slot go on slow I/O take it back: still ${RESOLVE_CONCURRENCY} mid-slice`, async () => {
    fakeTimers();
    let inFlight = 0;
    let peak = 0;
    const { resolver } = make({
      sessions: { s1: wSession },
      gitRoot: () => new Promise((r) => setTimeout(() => r('/w'), PARKED_IO_MS + 30)),
      stat: async (abs) => {
        if (abs.endsWith('/a.ts')) inFlight++;
        if (abs.endsWith('/b.ts')) inFlight--;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        return null;
      },
    });
    const all = Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        resolver.resolve('s1', [{ alts: [`/r${i}/a.ts`] }, { alts: [`/r${i}/b.ts`] }]),
      ),
    );
    await vi.runAllTimersAsync();
    await all;
    expect(peak).toBeLessThanOrEqual(RESOLVE_CONCURRENCY);
  });

  // Review r3: a token resumed from its yielded turn runs a CPU slice, so it must hold a slot even
  // when a parked sibling let the resolve's slot go while the turn was pending. setImmediate stays
  // real here so the turn can be held back while the fake clock fires the parked-I/O drop.
  it('a token resumed from its turn after the slot was let go waits for a slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const parked = new Map<string, () => void>();
    const calls: string[] = [];
    const { resolver } = make({
      sessions: { s1: wSession },
      stat: (abs) => {
        calls.push(abs);
        if (!abs.endsWith('/p.ts')) return Promise.resolve(null);
        return new Promise((r) => parked.set(abs, () => r(null)));
      },
    });
    const microtasks = async () => {
      for (let i = 0; i < 200; i++) await Promise.resolve();
    };
    const macrotask = () => new Promise((r) => setImmediate(r));

    const reply = resolver.resolve('s1', [{ alts: ['/r/p.ts'] }, { alts: ['/r/a.ts'] }]);
    await microtasks();
    expect(calls).toEqual(['/r/p.ts']);
    vi.advanceTimersByTime(PARKED_IO_MS + 1);
    const blockers = Array.from({ length: RESOLVE_CONCURRENCY }, (_, i) =>
      resolver.resolve('s1', [{ alts: [`/b${i}/p.ts`] }]),
    );
    await microtasks();
    expect(calls).toHaveLength(1 + RESOLVE_CONCURRENCY);
    await macrotask();
    await microtasks();
    await macrotask();
    expect(calls).not.toContain('/r/a.ts');

    for (let i = 0; i < RESOLVE_CONCURRENCY; i++) parked.get(`/b${i}/p.ts`)?.();
    await Promise.all(blockers);
    await microtasks();
    expect(calls).toContain('/r/a.ts');
    parked.get('/r/p.ts')?.();
    await reply;
  });

  // Review r3: a throw rejects the resolve while a sibling is parked; the sibling settling later
  // must not take a slot that nothing will release.
  it('a token that throws mid-resolve leaves both slots free once its parked siblings settle', async () => {
    fakeTimers();
    const parked: Array<() => void> = [];
    const malformed: IndexedFile = {
      rel: 'x.ts',
      get abs(): string {
        throw new Error('malformed index');
      },
    };
    const { resolver } = make({
      sessions: { s1: wSession },
      index: { '/w': { files: [malformed], coveredRoots: ['/w'] } },
      stat: (abs) =>
        abs.startsWith('/slow/')
          ? new Promise((r) => parked.push(() => r(null)))
          : Promise.resolve(null),
    });
    const failed = Array.from({ length: RESOLVE_CONCURRENCY }, () =>
      resolver.resolve('s1', [{ alts: ['/slow/a.ts'] }, { alts: ['x.ts'] }]).then(
        () => 'resolved',
        (e: unknown) => String(e),
      ),
    );
    await vi.advanceTimersByTimeAsync(PARKED_IO_MS + 1);
    expect(await Promise.all(failed)).toEqual(
      Array(RESOLVE_CONCURRENCY).fill('Error: malformed index'),
    );
    for (const release of parked) release();
    await vi.advanceTimersByTimeAsync(1);

    let after: string[] | undefined;
    void resolver.resolve('s1', [{ alts: ['/ok/a.ts'] }, { alts: ['/ok/b.ts'] }]).then((r) => {
      after = r.results.map((t) => t.key);
    });
    await vi.advanceTimersByTimeAsync(PARKED_IO_MS);
    expect(after).toEqual(['/ok/a.ts', '/ok/b.ts']);
  });

  // Review r2: the host-wide cap is for CPU slices; a resolve parked on I/O must not hold it.
  it.each([
    ['the git toplevel spawn', 'gitRoot'],
    ['a cold file-index build', 'fileIndex'],
    ['a stat on an offline mapped drive', 'stat'],
  ] as const)('a resolve blocked on %s does not delay another session', async (_label, where) => {
    fakeTimers();
    const parked: Array<() => void> = [];
    const park = <T>(value: T) => new Promise<T>((r) => parked.push(() => r(value)));
    const slow = (s: Session) => s.id !== 'fast';
    const sessions: Record<string, Session> = { fast: session({ id: 'fast', cwd: '/f' }) };
    for (let i = 0; i < RESOLVE_CONCURRENCY; i++)
      sessions[`slow${i}`] = session({ id: `slow${i}`, cwd: 'H:/share' });
    const { resolver } = make({
      sessions,
      gitRoot: (s) =>
        where === 'gitRoot' && slow(s) ? park(s.cwd ?? '') : Promise.resolve(s.cwd ?? ''),
      fileIndex: (root) =>
        where === 'fileIndex' && root.startsWith('H:')
          ? park({ files: [], coveredRoots: [] })
          : Promise.resolve({ files: [], coveredRoots: [] }),
      stat: (abs) =>
        where === 'stat' && abs.startsWith('H:')
          ? park(null)
          : Promise.resolve(abs === '/f/a.ts' ? 'file' : null),
    });
    const slowReplies = Object.keys(sessions)
      .filter((id) => id !== 'fast')
      .map((id) => resolver.resolve(id, [{ alts: ['a.ts'] }]));
    await vi.advanceTimersByTimeAsync(PARKED_IO_MS + 1);
    let fast: string[] | undefined;
    void resolver.resolve('fast', [{ alts: ['a.ts'] }]).then((r) => {
      fast = r.results[0].candidates.map((c) => c.absPath);
    });
    await vi.advanceTimersByTimeAsync(PARKED_IO_MS);
    expect(fast).toEqual(['/f/a.ts']);
    for (const release of parked) release();
    await vi.runAllTimersAsync();
    await Promise.all(slowReplies);
  });

  it('a registered repo root is its own toplevel: no git asked for it (Slice 6 budget)', async () => {
    const { resolver, topLevelCalls } = make({
      sessions: { s1: wSession },
      files: W_FILES,
      index: wIndex,
    });
    const { results } = await resolver.resolve('s1', [{ alts: ['src/index.ts'] }]);
    expect(results[0].candidates.map((c) => c.repoRoot)).toEqual(['/w/repoA', '/w/repoB']);
    expect(topLevelCalls).toEqual([]);
  });

  it('a file outside any repo copies relative to its user root, opens as a session on its folder (QA r1 D3)', async () => {
    const { resolver } = make({ sessions: { s1: session() }, files: ['/w/docs/notes/a.md'] });
    const [r] = (await resolver.resolve('s1', [{ alts: ['docs/notes/a.md'] }])).results;
    expect(r.candidates[0]).toMatchObject({
      absPath: '/w/docs/notes/a.md',
      repoRoot: '/w/docs/notes',
      relToRepo: 'docs/notes/a.md',
    });
  });

  it('the reply carries the live cwd used, the roots and the rootsSig', async () => {
    const s = session({ cwd: '/w/repoA', repos: [repo('/w/repoA')] });
    const { resolver } = make({ sessions: { s1: s } });
    const reply = await resolver.resolve('s1', []);
    expect(reply.cwd).toBe('/w/repoA');
    expect(reply.roots.map((r) => r.abs)).toEqual(['/w', '/w/repoA']);
    expect(reply.rootsSig).toMatch(/^[0-9a-f]{8}$/);
  });
});

// Plan T9.1 row 18: a UNC path links only under a UNC user root, with no stat at resolve time; the
// click-time probe budget is T4.1's `probe` test below.
describe('createPathLinkResolver — UNC tokens (row 18)', () => {
  it('under an attached //server/share root → one candidate, 0 stats', async () => {
    const { resolver, statCalls } = make({
      sessions: { s1: session({ roots: ['//server/share'] }) },
    });
    const { results } = await resolver.resolve('s1', [{ alts: ['//server/share/x.ts'] }]);
    expect(results[0].candidates.map((c) => c.absPath)).toEqual(['//server/share/x.ts']);
    expect(statCalls).toEqual([]);
  });

  it('without a UNC root → not linked, 0 stats', async () => {
    const { resolver, statCalls } = make({ sessions: { s1: session() } });
    const { results } = await resolver.resolve('s1', [{ alts: ['//server/share/x.ts'] }]);
    expect(results[0].candidates).toEqual([]);
    expect(statCalls).toEqual([]);
  });
});

// Plan T8.3: OSC 8 / file:// targets, decoded and confined host-side to the user-chosen roots.
describe("createPathLinkResolver target:'uri'", () => {
  const uri = (u: string) => ({ alts: [u], target: 'uri' as const });

  it('uri inside home → one exact-cwd candidate whose absPath is the realpath, with line', async () => {
    const { resolver } = make({
      sessions: { s1: session({ home: '/w' }) },
      files: ['/w/real/a.ts'],
      real: { '/w/link/a.ts': '/w/real/a.ts' },
    });
    const { results } = await resolver.resolve('s1', [uri('file:///w/link/a.ts#L3')]);
    expect(results[0].candidates).toHaveLength(1);
    expect(results[0].candidates[0]).toMatchObject({
      absPath: '/w/real/a.ts',
      strength: 'exact-cwd',
      rootIdx: 0,
      relToRoot: 'real/a.ts',
      isDir: false,
    });
    expect(results[0].line).toBe(3);
    expect(results[0].key).toBe('file:///w/link/a.ts#L3');
  });

  it('a dir target is a dir candidate', async () => {
    const { resolver } = make({ sessions: { s1: session() }, dirs: ['/w/src'] });
    const { results } = await resolver.resolve('s1', [uri('/w/src')]);
    expect(results[0].candidates[0]).toMatchObject({ absPath: '/w/src', isDir: true });
  });

  it('a confined target that does not exist → zero, not refused', async () => {
    const { resolver, debugs } = make({ sessions: { s1: session() } });
    const { results } = await resolver.resolve('s1', [uri('file:///w/nope.ts')]);
    expect(results[0].candidates).toEqual([]);
    expect(debugs).toEqual([]);
  });

  it('uri outside every root → zero; stat and realPathLeaf never called; logged once', async () => {
    const { resolver, statCalls, realCalls, debugs } = make({
      sessions: { s1: session() },
      files: ['/etc/passwd'],
    });
    const { results } = await resolver.resolve('s1', [uri('file:///etc/passwd')]);
    expect(results[0].candidates).toEqual([]);
    expect(statCalls).toEqual([]);
    expect(realCalls).toEqual([]);
    expect(debugs).toEqual([
      { scope: 'links', msg: 'uri-refused', data: { reason: 'outside-roots' } },
    ]);
  });

  it('an encoded .. out of home → zero; no fs', async () => {
    const { resolver, statCalls, realCalls } = make({
      sessions: { s1: session() },
      files: ['/etc/passwd'],
    });
    const { results } = await resolver.resolve('s1', [uri('file:///w/%2e%2e/etc/passwd')]);
    expect(results[0].candidates).toEqual([]);
    expect([...statCalls, ...realCalls]).toEqual([]);
  });

  it.each([
    'file:////h/s/x',
    'file://h/s/x',
    'file:///%5C%5Ch%5Cs%5Cx',
    String.raw`\\h\s\x`,
    '//h/s/x',
  ])('UNC-form uri %j → zero; stat and realPathLeaf never called', async (u) => {
    // Even with the share itself as home: a uri never reaches a UNC path.
    const { resolver, statCalls, realCalls, debugs } = make({
      sessions: { s1: session({ home: '//h/s' }) },
      files: ['//h/s/x'],
    });
    const { results } = await resolver.resolve('s1', [uri(u)]);
    expect(results[0].candidates).toEqual([]);
    expect([...statCalls, ...realCalls]).toEqual([]);
    expect(debugs.map((d) => d.data?.reason)).toEqual(['undecodable']);
  });

  it.each(['javascript:alert(1)', 'https://x/a.ts', 'src/a.ts', 'data:text/html,x'])(
    'a non-file uri %j → zero, no fs',
    async (u) => {
      const { resolver, statCalls, realCalls } = make({ sessions: { s1: session() } });
      const { results } = await resolver.resolve('s1', [uri(u)]);
      expect(results[0].candidates).toEqual([]);
      expect([...statCalls, ...realCalls]).toEqual([]);
    },
  );

  it('realpath escape into a sibling root → zero, never stat’ed', async () => {
    const { resolver, statCalls } = make({
      sessions: { s1: session({ home: '/w', roots: ['/other'] }) },
      files: ['/other/x.ts'],
      real: { '/w/link/x.ts': '/other/x.ts' },
    });
    const { results } = await resolver.resolve('s1', [uri('file:///w/link/x.ts')]);
    expect(results[0].candidates).toEqual([]);
    expect(statCalls).toEqual([]);
  });

  it('a uri under a nested repo is confined to that repo, the deepest user root', async () => {
    const { resolver, realCalls } = make({
      sessions: { s1: session({ home: '/w', repos: [repo('/w/repoA')] }) },
      files: ['/w/repoA/a.ts'],
    });
    const { results } = await resolver.resolve('s1', [uri('file:///w/repoA/a.ts')]);
    expect(results[0].candidates.map((c) => c.absPath)).toEqual(['/w/repoA/a.ts']);
    expect(realCalls).toContain('/w/repoA');
  });

  it('cwd moved outside every user root → its repo is a display root, never a confinement root', async () => {
    const { resolver, statCalls, realCalls } = make({
      sessions: { s1: session({ home: '/w', cwd: '/elsewhere/repoX' }) },
      gitRoot: '/elsewhere/repoX',
      files: ['/elsewhere/repoX/a.ts'],
    });
    const { results, roots } = await resolver.resolve('s1', [uri('file:///elsewhere/repoX/a.ts')]);
    expect(roots.map((r) => r.abs)).toContain('/elsewhere/repoX');
    expect(results[0].candidates).toEqual([]);
    expect([...statCalls, ...realCalls]).toEqual([]);
  });

  it('cwd moved to a foreign share → neither the token nor the uri reaches the fs', async () => {
    const { resolver, statCalls, realCalls } = make({
      sessions: { s1: session({ home: '//srv/share', cwd: '//evil/share/repo' }) },
      gitRoot: '//evil/share/repo',
      files: ['//evil/share/repo/a.ts'],
    });
    const { results } = await resolver.resolve('s1', [
      { alts: ['//evil/share/repo/a.ts'] },
      uri('file:////evil/share/repo/a.ts'),
      uri('//evil/share/repo/a.ts'),
    ]);
    expect(results.map((r) => r.candidates.length)).toEqual([0, 0, 0]);
    expect([...statCalls, ...realCalls]).toEqual([]);
  });

  it('a uri entry in a mixed batch does not affect the other entries', async () => {
    const { resolver } = make({
      sessions: { s1: session({ cwd: '/w/repoA', repos: [repo('/w/repoA')] }) },
      files: ['/w/repoA/src/index.ts', '/w/a.ts'],
    });
    const { results } = await resolver.resolve('s1', [
      { alts: ['src/index.ts'] },
      uri('file:///etc/passwd'),
      'junk',
      uri('file:///w/a.ts:7:2'),
    ]);
    expect(results.map((r) => r.key)).toEqual([
      'src/index.ts',
      'file:///etc/passwd',
      '',
      'file:///w/a.ts:7:2',
    ]);
    expect(results[0].candidates.map((c) => c.absPath)).toEqual(['/w/repoA/src/index.ts']);
    expect(results[0].line).toBeUndefined();
    expect(results[1].candidates).toEqual([]);
    expect(results[2].error).toBe('invalid');
    expect(results[3]).toMatchObject({ line: 7, col: 2 });
    expect(results[3].candidates.map((c) => c.absPath)).toEqual(['/w/a.ts']);
  });

  it('a target other than exactly "uri" is a path token', async () => {
    const { resolver, realCalls } = make({ sessions: { s1: session() }, files: ['/w/a.ts'] });
    const { results } = await resolver.resolve('s1', [{ alts: ['/w/a.ts'], target: 'URI' }]);
    expect(results[0].candidates.map((c) => c.absPath)).toEqual(['/w/a.ts']);
    expect(realCalls).toEqual([]);
  });

  it('a file at a drive root: its folder keeps the separator (G:/, not G:)', async () => {
    const { resolver, topLevelCalls } = make({
      sessions: { s1: session({ home: 'G:/' }) },
      platform: 'win32',
      caseSensitive: false,
      files: ['G:/a.ts'],
    });
    const { results } = await resolver.resolve('s1', [uri('file:///G:/a.ts')]);
    expect(results[0].candidates[0]).toMatchObject({ absPath: 'G:/a.ts', repoRoot: 'G:/' });
    expect(topLevelCalls).toEqual(['G:/']);
  });

  it('a file at the posix root: its folder is /', async () => {
    const { resolver } = make({ sessions: { s1: session({ home: '/' }) }, files: ['/a.ts'] });
    const { results } = await resolver.resolve('s1', [uri('file:///a.ts')]);
    expect(results[0].candidates[0]).toMatchObject({ absPath: '/a.ts', repoRoot: '/' });
  });

  it('outside any repo: relative to the user root it is under; Open as session keeps its folder (QA r1 D3)', async () => {
    const { resolver } = make({ sessions: { s1: session() }, files: ['/w/docs/notes/a.md'] });
    const { results } = await resolver.resolve('s1', [uri('file:///w/docs/notes/a.md')]);
    expect(results[0].candidates[0]).toMatchObject({
      repoRoot: '/w/docs/notes',
      relToRepo: 'docs/notes/a.md',
    });
  });

  it('a uri only uses its first alt', async () => {
    const { resolver, statCalls } = make({ sessions: { s1: session() }, files: ['/w/b.ts'] });
    const { results } = await resolver.resolve('s1', [
      { alts: ['file:///etc/x', '/w/b.ts'], target: 'uri' },
    ]);
    expect(results[0].candidates).toEqual([]);
    expect(statCalls).toEqual([]);
  });

  it('an elision-shaped realpath is opened as itself, never suffix-searched', async () => {
    const { resolver, indexCalls } = make({
      sessions: { s1: session() },
      index: wIndex,
      files: ['/w/…/src/index.ts'],
    });
    const { results } = await resolver.resolve('s1', [uri('/w/…/src/index.ts')]);
    expect(results[0].candidates.map((c) => c.absPath)).toEqual(['/w/…/src/index.ts']);
    expect(indexCalls).toEqual([]);
  });

  it('win32: another drive-letter / folder case is confined case-folded', async () => {
    const { resolver } = make({
      sessions: { s1: session({ home: 'G:/w' }) },
      platform: 'win32',
      caseSensitive: false,
      files: ['G:/W/a.ts'],
    });
    const { results } = await resolver.resolve('s1', [uri('file:///g:/W/a.ts')]);
    expect(results[0].candidates.map((c) => c.absPath)).toEqual(['G:/W/a.ts']);
  });
});

// Plan T4.1: the click-time probe behind the async `pathExists` handler.
describe('PathLinkResolver.probe', () => {
  const withStat = (stat: PathLinkResolverDeps['stat']) => make({ sessions: {}, stat }).resolver;

  it('probe → file / dir / null', async () => {
    const r = withStat(async (abs) => (abs === '/f' ? 'file' : abs === '/d' ? 'dir' : null));
    expect(await r.probe('/f')).toBe('file');
    expect(await r.probe('/d')).toBe('dir');
    expect(await r.probe('/x')).toBeNull();
  });

  it('a stat that throws → null', async () => {
    const r = withStat(async () => {
      throw new Error('EPERM');
    });
    expect(await r.probe('/f')).toBeNull();
  });

  it('a UNC-like path whose stat never settles → null after UNC_PROBE_BUDGET_MS', async () => {
    vi.useFakeTimers();
    const r = withStat(() => new Promise(() => {}));
    let out: string | null | undefined;
    void r.probe('//srv/share/x').then((k) => {
      out = k;
    });
    await vi.advanceTimersByTimeAsync(UNC_PROBE_BUDGET_MS - 1);
    expect(out).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toBeNull();
  });

  it('a non-UNC path is not raced: a slow local stat still answers', async () => {
    vi.useFakeTimers();
    const r = withStat(
      () => new Promise((res) => setTimeout(() => res('file'), UNC_PROBE_BUDGET_MS * 4)),
    );
    let out: string | null | undefined;
    void r.probe('/slow').then((k) => {
      out = k;
    });
    await vi.advanceTimersByTimeAsync(UNC_PROBE_BUDGET_MS * 4);
    expect(out).toBe('file');
  });
});

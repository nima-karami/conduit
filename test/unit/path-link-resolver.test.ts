import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPathLinkResolver,
  MAX_TOKENS,
  type PathLinkResolverDeps,
  STAT_CONCURRENCY,
  UNC_PROBE_BUDGET_MS,
} from '../../electron/path-link-resolver';
import type { IndexedFile } from '../../src/path-resolve';
import type { RepoInfo } from '../../src/repo-scan';
import type { Session } from '../../src/types';

afterEach(() => vi.useRealTimers());

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
  gitRoot?: string;
  stat?: PathLinkResolverDeps['stat'];
}

function make(f: Fake) {
  const fs = new Set(f.files ?? []);
  const statCalls: string[] = [];
  const indexCalls: string[] = [];
  const deps: PathLinkResolverDeps = {
    getSession: (id) => f.sessions[id],
    gitRoot: async (s) => f.gitRoot ?? s.cwd ?? s.home,
    fileIndex: async (root) => {
      indexCalls.push(root);
      const ix = f.index?.[root];
      if (ix === 'reject') throw new Error('index failed');
      return ix ?? { files: [], coveredRoots: [] };
    },
    stat:
      f.stat ??
      (async (abs) => {
        statCalls.push(abs);
        return fs.has(abs) ? 'file' : null;
      }),
    topLevel: async () => '',
    homeDir: '/home/u',
    platform: 'posix',
    caseSensitive: true,
  };
  return { resolver: createPathLinkResolver(deps), statCalls, indexCalls };
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

  it('a fileIndex rejection degrades to exact-only: every root is stat’ed, no throw', async () => {
    const { resolver, statCalls } = make({
      sessions: { s1: wSession },
      files: W_FILES,
      index: { '/w': 'reject' },
    });
    const { results } = await resolver.resolve('s1', [{ alts: ['src/index.ts'] }]);
    expect(results[0].candidates).toHaveLength(2);
    expect(statCalls).toEqual(
      expect.arrayContaining(['/w/repoA/src/index.ts', '/w/repoB/src/index.ts']),
    );
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

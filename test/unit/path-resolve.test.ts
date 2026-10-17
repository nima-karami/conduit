import { describe, expect, it } from 'vitest';
import type { ResolveRoot } from '../../src/path-link-roots';
import {
  DEFAULT_CANDIDATE_CAP,
  IGNORED_FALLBACK_BATCH,
  type IndexedFile,
  isUncLike,
  MAX_ALTS,
  memoFor,
  type ResolveCtx,
  type ResolveDeps,
  type ResolveIndex,
  resolveTokens,
} from '../../src/path-resolve';

/** A fake async fs: `stat` answers from a set of files and dirs and logs every call. */
function fakeFs(
  files: string[],
  dirs: string[] = [],
  topLevels: Record<string, string> = {},
  opts: { fold?: boolean } = {},
) {
  const f = (s: string) => (opts.fold ? s.toLowerCase() : s);
  const fileSet = new Set(files.map(f));
  const dirSet = new Set(dirs.map(f));
  const statCalls: string[] = [];
  const deps: ResolveDeps = {
    stat: async (abs) => {
      statCalls.push(abs);
      if (fileSet.has(f(abs))) return 'file';
      if (dirSet.has(f(abs))) return 'dir';
      return null;
    },
    topLevel: async (dir) => topLevels[dir] ?? '',
  };
  return { deps, statCalls };
}

const root = (
  abs: string,
  kind: ResolveRoot['kind'],
  extra: Partial<ResolveRoot> = {},
): ResolveRoot => ({
  abs,
  kind,
  name: abs.split('/').pop() ?? abs,
  userChosen: true,
  ...extra,
});

const one = async (raw: string, ctx: ResolveCtx, deps: ResolveDeps) =>
  (await resolveTokens([{ alts: [raw] }], ctx, deps))[0];

// ── Ported from the v1 sync resolveToken suite (same it names and candidate sets). ─────────────

const files: IndexedFile[] = [
  { rel: 'src/core/theme/accent.ts', abs: '/repo/src/core/theme/accent.ts' },
  { rel: 'src/a/config.ts', abs: '/repo/src/a/config.ts' },
  { rel: 'src/b/config.ts', abs: '/repo/src/b/config.ts' },
  { rel: 'webview/app.tsx', abs: '/repo/webview/app.tsx' },
  { rel: 'README.md', abs: '/repo/README.md' },
];

const ctx = (over: Partial<ResolveCtx> & { files?: IndexedFile[] } = {}): ResolveCtx => {
  const { files: f = files, ...rest } = over;
  return {
    cwd: '/repo',
    cwdGitRoot: '/repo',
    roots: [root('/repo', 'home')],
    indexes: [{ root: '/repo', files: f, coveredRootIdx: [0] }],
    caseSensitive: true,
    homeDir: '/home/u',
    platform: 'posix',
    cap: 50,
    ...rest,
  };
};

const makeStat = (dirs: string[] = []) =>
  fakeFs(
    files.map((f) => f.abs),
    dirs,
  ).deps;

describe('resolveToken — rule 1 (exact)', () => {
  it('resolves a bare project-relative path against cwd to exactly one file', async () => {
    const r = await one('src/core/theme/accent.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].absPath).toBe('/repo/src/core/theme/accent.ts');
    expect(r.candidates[0].relToRoot).toBe('src/core/theme/accent.ts');
    expect(r.candidates[0].isDir).toBe(false);
  });

  it('falls back from cwd to project root when cwd is a subdir', async () => {
    const r = await one('webview/app.tsx', ctx({ cwd: '/repo/src' }), makeStat());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].absPath).toBe('/repo/webview/app.tsx');
  });

  it('resolves a directory token as a single dir candidate (isDir)', async () => {
    const r = await one('src/core', ctx(), makeStat(['/repo/src/core']));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].isDir).toBe(true);
    expect(r.candidates[0].relToRoot).toBe('src/core');
  });

  it('an absolute token that exists resolves as-is and never suffix-searches', async () => {
    const r = await one('/repo/src/a/config.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].absPath).toBe('/repo/src/a/config.ts');
  });

  it('an absolute token that is missing yields no candidates (no suffix fallback)', async () => {
    const r = await one('/nowhere/config.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(0);
  });
});

describe('resolveToken — rule 2 (suffix search)', () => {
  it('a bare filename with one match opens directly', async () => {
    const r = await one('accent.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/core/theme/accent.ts']);
  });

  it('an ambiguous filename returns all matches (for the dropdown), shortest-path first', async () => {
    const r = await one('config.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/a/config.ts', 'src/b/config.ts']);
  });

  it('matches only on a segment boundary (not a substring of a segment)', async () => {
    const r = await one('cent.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(0);
  });

  // The v1 fixture's cwd/root '/elsewhere' held files under '/repo'; candidates now carry the
  // root they lie in, so the index root is '/repo' and only the cwd is elsewhere.
  it('a relative suffix that is not exact still suffix-matches', async () => {
    const r = await one(
      'theme/accent.ts',
      ctx({ cwd: '/elsewhere', cwdGitRoot: '/elsewhere' }),
      makeStat(),
    );
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/core/theme/accent.ts']);
  });

  it('returns nothing for a filename with no match', async () => {
    expect((await one('nope.ts', ctx(), makeStat())).candidates).toHaveLength(0);
  });
});

// The v1 heads (`C://my-games`, `/home`, `C:/proj`) lay outside the fixture's root. Spec row 35
// now keeps only candidates under an absolute head, so the heads lie over the fixture.
describe('resolveToken — abbreviated paths (... elision)', () => {
  it('resolves a drive-absolute elided path by suffix-searching the tail filename', async () => {
    const win: IndexedFile[] = [
      { rel: 'src/core/theme/accent.ts', abs: 'C:/my-games/src/core/theme/accent.ts' },
    ];
    const r = await one(
      'C://my-games/.../accent.ts',
      ctx({
        cwd: 'C:/my-games',
        cwdGitRoot: 'C:/my-games',
        roots: [root('C:/my-games', 'home')],
        indexes: [{ root: 'C:/my-games', files: win, coveredRootIdx: [0] }],
        platform: 'win32',
        caseSensitive: false,
      }),
      fakeFs([]).deps,
    );
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/core/theme/accent.ts']);
  });

  it('resolves an elided path with a multi-segment concrete tail', async () => {
    const r = await one('/repo/.../theme/accent.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/core/theme/accent.ts']);
  });

  it('a leading-elision token suffix-searches the tail', async () => {
    const r = await one('.../webview/app.tsx', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['webview/app.tsx']);
  });

  it('an ambiguous elided tail returns all matches for the dropdown', async () => {
    const r = await one('/repo/.../config.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/a/config.ts', 'src/b/config.ts']);
  });

  it('uses only the tail after the LAST elision', async () => {
    const r = await one('.../src/.../accent.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/core/theme/accent.ts']);
  });
});

describe('resolveToken — cap, truncation, case-sensitivity', () => {
  it('caps candidates and flags truncated', async () => {
    const many: IndexedFile[] = Array.from({ length: 5 }, (_, i) => ({
      rel: `d${i}/x.ts`,
      abs: `/repo/d${i}/x.ts`,
    }));
    const r = await one('x.ts', ctx({ files: many, cap: 3 }), fakeFs([]).deps);
    expect(r.candidates).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('case-insensitive match when caseSensitive is false (Windows/macOS)', async () => {
    const r = await one('ACCENT.TS', ctx({ caseSensitive: false }), makeStat());
    expect(r.candidates.map((c) => c.relToRoot)).toEqual(['src/core/theme/accent.ts']);
  });

  it('case-SENSITIVE match misses a differently-cased token (Linux)', async () => {
    const r = await one('ACCENT.TS', ctx({ caseSensitive: true }), makeStat());
    expect(r.candidates).toHaveLength(0);
  });
});

// ── v2 matrix (spec §2.2), fixture S3: home /w, repos repoA, repoB, T-123/repoA-wt. ─────────

const W_FILES = [
  '/w/repoA/src/index.ts',
  '/w/repoB/src/index.ts',
  '/w/T-123/repoA-wt/src/index.ts',
];
const W_DIRS = [
  '/w',
  '/w/repoA',
  '/w/repoB',
  '/w/T-123/repoA-wt',
  '/w/repoA/src',
  '/w/repoB/src',
  '/w/T-123/repoA-wt/src',
];
const W_TOP: Record<string, string> = {
  '/w/repoA': '/w/repoA',
  '/w/repoB': '/w/repoB',
  '/w/T-123/repoA-wt': '/w/T-123/repoA-wt',
};
const wIndexFiles = (extra: string[] = []): IndexedFile[] =>
  [...W_FILES, '/w/repoA/lib/index.ts', ...extra].map((abs) => ({ rel: abs.slice(3), abs }));
const W_ROOTS = [
  root('/w', 'home'),
  root('/w/repoA', 'nested'),
  root('/w/T-123/repoA-wt', 'worktree', { name: 'repoA-wt', branch: 'feat/x' }),
  root('/w/repoB', 'nested'),
];
const wCtx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  cwd: '/w',
  cwdGitRoot: '/w',
  roots: W_ROOTS,
  indexes: [{ root: '/w', files: wIndexFiles(), coveredRootIdx: [1, 2, 3] }],
  caseSensitive: true,
  homeDir: '/home/u',
  platform: 'posix',
  ...over,
});
const wFs = (extraFiles: string[] = [], extraDirs: string[] = []) =>
  fakeFs([...W_FILES, '/w/repoA/lib/index.ts', ...extraFiles], [...W_DIRS, ...extraDirs], W_TOP);
const names = (cands: { rootIdx: number }[], roots = W_ROOTS) =>
  cands.map((c) => (c.rootIdx < 0 ? '-' : roots[c.rootIdx].name));

describe('resolveTokens — v2 matrix', () => {
  it('row 2: parent of many → one exact-root per repo; covered roots answer by membership', async () => {
    const { deps, statCalls } = wFs();
    const r = await one('src/index.ts', wCtx(), deps);
    expect(names(r.candidates)).toEqual(['repoA', 'repoA-wt', 'repoB']);
    expect(r.candidates.every((c) => c.strength === 'exact-root')).toBe(true);
    expect(r.candidates.every((c) => c.relToRoot === 'src/index.ts')).toBe(true);
    expect(statCalls).toEqual(['/w/src/index.ts']);
    expect(r).toMatchObject({ key: 'src/index.ts', total: 3, truncated: false });
  });

  describe('gitignored files in covered roots (review r1 SF2)', () => {
    it('a token with a separator that misses membership is stat’ed in each covered root', async () => {
      const { deps, statCalls } = wFs(['/w/repoB/dist/x.js']);
      const r = await one('dist/x.js', wCtx(), deps);
      expect(names(r.candidates)).toEqual(['repoB']);
      expect(r.candidates[0]).toMatchObject({ strength: 'exact-root', isDir: false });
      expect(statCalls).toEqual([
        '/w/dist/x.js',
        '/w/repoA/dist/x.js',
        '/w/T-123/repoA-wt/dist/x.js',
        '/w/repoB/dist/x.js',
      ]);
    });

    it('a dotfile basename that misses membership is stat’ed in each covered root', async () => {
      const { deps } = wFs(['/w/repoA/.env']);
      expect(names((await one('.env', wCtx(), deps)).candidates)).toEqual(['repoA']);
    });

    it('a bare prose-like word that misses membership is never stat’ed in a covered root', async () => {
      const { deps, statCalls } = wFs(['/w/repoA/ignored.ts']);
      expect((await one('ignored.ts', wCtx(), deps)).candidates).toHaveLength(0);
      expect(statCalls).toEqual(['/w/ignored.ts']);
    });

    it('a token with a . or .. segment never reaches the fallback stat (review r2)', async () => {
      const { deps, statCalls } = wFs(['/w/repoA/../shared/x.ts']);
      expect((await one('../shared/x.ts', wCtx(), deps)).candidates).toHaveLength(0);
      expect(statCalls).toHaveLength(1);
    });

    it('a membership hit anywhere skips the fallback', async () => {
      const { deps, statCalls } = wFs(['/w/repoB/src/index.ts']);
      await one('src/index.ts', wCtx(), deps);
      expect(statCalls).toEqual(['/w/src/index.ts']);
    });

    it(`stats ${IGNORED_FALLBACK_BATCH} roots at a time, yielding before each batch`, async () => {
      const many = Array.from({ length: 10 }, (_, i) => root(`/m/r${i}`, 'nested'));
      let inFlight = 0;
      let peak = 0;
      let yields = 0;
      const deps: ResolveDeps = {
        stat: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((res) => setTimeout(res, 1));
          inFlight--;
          return null;
        },
        topLevel: async () => '',
        yieldTurn: async () => {
          yields++;
        },
      };
      await one(
        'dist/x.js',
        wCtx({
          cwd: '/m',
          cwdGitRoot: '/m',
          roots: [root('/m', 'home'), ...many],
          indexes: [{ root: '/m', files: [], coveredRootIdx: many.map((_, i) => i + 1) }],
        }),
        deps,
      );
      expect(peak).toBe(IGNORED_FALLBACK_BATCH);
      expect(yields).toBe(Math.ceil(10 / IGNORED_FALLBACK_BATCH));
    });
  });

  it('yields between tokens, never before the first', async () => {
    const { deps } = wFs();
    let yields = 0;
    await resolveTokens(
      [{ alts: ['src/index.ts'] }, { alts: ['index.ts'] }, { alts: ['zzz.ts'] }],
      wCtx(),
      {
        ...deps,
        yieldTurn: async () => {
          yields++;
        },
      },
    );
    expect(yields).toBe(2);
  });

  it('the first index listing a root answers for it', async () => {
    const { deps } = wFs();
    const r = await one(
      'src/index.ts',
      wCtx({
        indexes: [
          { root: '/w', files: [], coveredRootIdx: [1] },
          { root: '/w', files: wIndexFiles(), coveredRootIdx: [1, 2, 3] },
        ],
      }),
      deps,
    );
    expect(names(r.candidates)).toEqual(['repoA-wt', 'repoB']);
  });

  it('a root no index covers is stat’ed', async () => {
    const { deps, statCalls } = wFs(['/w/repoA/src/ignored.ts']);
    const r = await one(
      'src/ignored.ts',
      wCtx({ indexes: [{ root: '/w', files: [], coveredRootIdx: [] }] }),
      deps,
    );
    expect(names(r.candidates)).toEqual(['repoA']);
    expect(statCalls).toContain('/w/repoA/src/ignored.ts');
  });

  it('row 45: a dir token is stat’ed even in a covered root, via exact joins only', async () => {
    const { deps } = wFs();
    const r = await one('src/', wCtx(), deps);
    expect(names(r.candidates)).toEqual(['repoA', 'repoA-wt', 'repoB']);
    expect(r.candidates.every((c) => c.isDir && c.strength === 'exact-root')).toBe(true);
  });

  it('index memo is per array identity', () => {
    const f = wIndexFiles();
    expect(memoFor(f, false)).toBe(memoFor(f, false));
    expect(memoFor(f, true)).not.toBe(memoFor(f, false));
    expect(memoFor(wIndexFiles(), false)).not.toBe(memoFor(f, false));
  });

  describe('rule 2: UNC and device paths are never stat’ed', () => {
    it('no UNC root → not linked, 0 stats', async () => {
      const { deps, statCalls } = wFs();
      expect((await one('//srv/share/a.ts', wCtx(), deps)).candidates).toHaveLength(0);
      expect((await one('\\\\srv\\share\\a.ts', wCtx(), deps)).candidates).toHaveLength(0);
      expect(statCalls).toEqual([]);
    });

    it('under a user-chosen UNC root → one exact-cwd candidate, 0 stats', async () => {
      const { deps, statCalls } = wFs();
      const roots = [...W_ROOTS, root('//srv/share', 'attached')];
      const r = await one('//srv/share/a.ts', wCtx({ roots }), deps);
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]).toMatchObject({
        strength: 'exact-cwd',
        absPath: '//srv/share/a.ts',
        isDir: false,
        rootIdx: 4,
      });
      expect(statCalls).toEqual([]);
    });

    it('a UNC root that is not user-chosen admits nothing', async () => {
      const { deps, statCalls } = wFs();
      const roots = [root('//evil/share/repo', 'cwd-repo', { userChosen: false }), ...W_ROOTS];
      expect((await one('//evil/share/repo/a.ts', wCtx({ roots }), deps)).candidates).toHaveLength(
        0,
      );
      expect(statCalls).toEqual([]);
    });

    it('a relative token with a UNC root → membership only; a non-user UNC cwd is never joined', async () => {
      const { deps, statCalls } = wFs();
      const unc: IndexedFile[] = [{ rel: 'src/x.ts', abs: '//srv/share/src/x.ts' }];
      const r = await one(
        'src/x.ts',
        wCtx({
          cwd: '//evil/x',
          cwdGitRoot: '//evil/x',
          roots: [root('//srv/share', 'attached')],
          indexes: [{ root: '//srv/share', files: unc, coveredRootIdx: [0] }],
        }),
        deps,
      );
      expect(r.candidates.map((c) => [c.absPath, c.strength])).toEqual([
        ['//srv/share/src/x.ts', 'exact-root'],
      ]);
      expect(statCalls).toEqual([]);
    });

    it('a UNC root no index covers is never stat’ed, for a file or a dir token', async () => {
      const { deps, statCalls } = wFs();
      const roots = [...W_ROOTS, root('//srv/share', 'attached')];
      await one('src/x.ts', wCtx({ roots }), deps);
      await one('src/', wCtx({ roots }), deps);
      expect(statCalls.filter((p) => p.startsWith('//'))).toEqual([]);
    });

    it('a device path is refused, 0 stats', async () => {
      const { deps, statCalls } = wFs();
      expect((await one('\\\\?\\G:\\w\\a.ts', wCtx(), deps)).candidates).toHaveLength(0);
      expect((await one('//./pipe/x', wCtx(), deps)).candidates).toHaveLength(0);
      expect(statCalls).toEqual([]);
    });

    it('re-exports isUncLike', () => {
      expect(isUncLike('\\\\host\\x')).toBe(true);
    });
  });

  it('win32 case: a differently-cased absolute token lands in its root', async () => {
    const roots = [root('G:/w/repoA', 'home')];
    const { deps } = fakeFs(['G:/w/repoA/src/index.ts'], [], {}, { fold: true });
    const r = await one(
      'G:\\W\\REPOA\\src\\index.ts',
      {
        ...wCtx(),
        roots,
        indexes: [],
        cwd: 'G:/w/repoA',
        cwdGitRoot: 'G:/w/repoA',
        platform: 'win32',
        caseSensitive: false,
      },
      deps,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      rootIdx: 0,
      strength: 'exact-cwd',
      relToRoot: 'src/index.ts',
    });
  });

  it('row 1: cwd repoA → exact-cwd repoA plus the others as exact-root', async () => {
    const { deps } = wFs();
    const r = await one('src/index.ts', wCtx({ cwd: '/w/repoA', cwdGitRoot: '/w/repoA' }), deps);
    expect(r.candidates.map((c) => [names([c])[0], c.strength])).toEqual([
      ['repoA', 'exact-cwd'],
      ['repoA-wt', 'exact-root'],
      ['repoB', 'exact-root'],
    ]);
  });

  it('row 5: home repoA + attached repoB → exact-cwd repoA, then exact-root repoB', async () => {
    const roots = [root('/w/repoA', 'home'), root('/w/repoB', 'attached')];
    const idx = (r: string, i: number): ResolveIndex => ({
      root: r,
      files: [{ rel: 'src/index.ts', abs: `${r}/src/index.ts` }],
      coveredRootIdx: [i],
    });
    const { deps } = wFs();
    const r = await one(
      'src/index.ts',
      wCtx({
        cwd: '/w/repoA',
        cwdGitRoot: '/w/repoA',
        roots,
        indexes: [idx('/w/repoA', 0), idx('/w/repoB', 1)],
      }),
      deps,
    );
    expect(r.candidates.map((c) => [names([c], roots)[0], c.strength])).toEqual([
      ['repoA', 'exact-cwd'],
      ['repoB', 'exact-root'],
    ]);
  });

  it('row 13: ../repoB from cwd repoA normalises the absPath', async () => {
    const { deps } = wFs();
    const r = await one(
      '../repoB/src/index.ts',
      wCtx({ cwd: '/w/repoA', cwdGitRoot: '/w/repoA' }),
      deps,
    );
    expect(r.candidates[0]).toMatchObject({
      absPath: '/w/repoB/src/index.ts',
      strength: 'exact-cwd',
    });
  });

  it('row 23: ~/x.ts expands to the home dir', async () => {
    const { deps } = fakeFs(['/home/u/x.ts']);
    const r = await one('~/x.ts', wCtx(), deps);
    expect(r.candidates[0]).toMatchObject({
      absPath: '/home/u/x.ts',
      rootIdx: -1,
      relToRoot: '/home/u/x.ts',
    });
  });

  it('rows 32, 33: … and ... elision suffix-search every root', async () => {
    const { deps } = wFs();
    for (const raw of ['…/src/index.ts', '.../src/index.ts']) {
      const r = await one(raw, wCtx(), deps);
      expect(names(r.candidates)).toEqual(['repoA', 'repoA-wt', 'repoB']);
      expect(r.candidates.every((c) => c.strength === 'suffix')).toBe(true);
    }
  });

  it('row 35: an absolute head keeps only candidates under it', async () => {
    const { deps } = wFs();
    const r = await one('/w/repoB/.../index.ts', wCtx(), deps);
    expect(names(r.candidates)).toEqual(['repoB']);
  });

  it('row 36: a tail segment that began with … matches as a segment suffix', async () => {
    const { deps } = wFs();
    const r = await one('…rc/index.ts', wCtx(), deps);
    expect(names(r.candidates)).toEqual(['repoA', 'repoA-wt', 'repoB']);
    expect(r.candidates.map((c) => c.relToRoot)).not.toContain('lib/index.ts');
  });

  it('row 47: an absolute root dir → relToRoot "" and isDir', async () => {
    const { deps } = wFs();
    const r = await one('/w/repoA/', wCtx(), deps);
    expect(r.candidates[0]).toMatchObject({
      rootIdx: 1,
      relToRoot: '',
      isDir: true,
      absPath: '/w/repoA',
    });
  });

  it('dedupe: one file found via home and via the nested repo keeps the deepest root', async () => {
    const roots = [root('/w', 'home'), root('/w/repoA', 'nested')];
    const { deps } = wFs();
    const r = await one(
      'index.ts',
      wCtx({
        cwd: '/elsewhere',
        cwdGitRoot: '/elsewhere',
        roots,
        indexes: [
          {
            root: '/w',
            files: [{ rel: 'repoA/src/index.ts', abs: '/w/repoA/src/index.ts' }],
            coveredRootIdx: [],
          },
          {
            root: '/w/repoA',
            files: [{ rel: 'src/index.ts', abs: '/w/repoA/src/index.ts' }],
            coveredRootIdx: [1],
          },
        ],
      }),
      deps,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ rootIdx: 1, relToRoot: 'src/index.ts' });
  });

  describe('repoRoot', () => {
    it('nested → the repo', async () => {
      const { deps } = wFs();
      const r = await one('src/index.ts', wCtx(), deps);
      expect(r.candidates[0]).toMatchObject({ repoRoot: '/w/repoA', relToRepo: 'src/index.ts' });
    });

    it('a file under a non-git home outside any repo → the containing folder', async () => {
      const { deps } = wFs(['/w/notes/x.md']);
      const r = await one('notes/x.md', wCtx(), deps);
      expect(r.candidates[0]).toMatchObject({
        rootIdx: 0,
        repoRoot: '/w/notes',
        relToRepo: 'x.md',
      });
    });

    it('an absolute path outside every root → rootIdx -1, repoRoot from topLevel', async () => {
      const { deps } = fakeFs(['/elsewhere/r/sub/f.ts'], [], {
        '/elsewhere/r/sub': '/elsewhere/r',
      });
      const r = await one('/elsewhere/r/sub/f.ts', wCtx(), deps);
      expect(r.candidates[0]).toMatchObject({
        rootIdx: -1,
        relToRoot: '/elsewhere/r/sub/f.ts',
        repoRoot: '/elsewhere/r',
        relToRepo: 'sub/f.ts',
      });
    });
  });

  it('cap: 250 suffix hits → 200, truncated, total 250', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `/w/d${i}/x.ts`);
    const { deps } = wFs();
    const r = await one(
      'x.ts',
      wCtx({ indexes: [{ root: '/w', files: wIndexFiles(many), coveredRootIdx: [] }] }),
      deps,
    );
    expect(r.candidates).toHaveLength(DEFAULT_CANDIDATE_CAP);
    expect(r).toMatchObject({ truncated: true, total: 250 });
  });

  it('case: caseSensitive false matches SRC/Index.ts by suffix', async () => {
    const { deps } = wFs();
    const r = await one('…/SRC/Index.ts', wCtx({ caseSensitive: false }), deps);
    expect(r.candidates).toHaveLength(3);
  });

  it('alts: falls back to alts[1] when alts[0] finds nothing; the key joins every alt', async () => {
    const { deps } = wFs();
    const [r] = await resolveTokens(
      [{ alts: ['Update(src/index.ts', 'src/index.ts'] }],
      wCtx(),
      deps,
    );
    expect(r.key).toBe('Update(src/index.ts\0src/index.ts');
    expect(r.candidates).toHaveLength(3);
  });

  it('alts: the last of MAX_ALTS alts is tried', async () => {
    const { deps } = wFs();
    const alts = [...Array.from({ length: MAX_ALTS - 1 }, (_, i) => `n${i}.ts`), 'src/index.ts'];
    const [r] = await resolveTokens([{ alts }], wCtx(), deps);
    expect(r.candidates).toHaveLength(3);
  });

  it('a stat or topLevel that throws is a miss, never a rejection', async () => {
    const deps: ResolveDeps = {
      stat: async () => {
        throw new Error('EPERM');
      },
      topLevel: async () => {
        throw new Error('git gone');
      },
    };
    const [abs, rel] = await resolveTokens(
      [{ alts: ['/w/repoA/src/index.ts'] }, { alts: ['src/index.ts'] }],
      wCtx(),
      deps,
    );
    expect(abs.candidates).toHaveLength(0);
    expect(rel.candidates).toHaveLength(3);
    expect(rel.candidates[0].repoRoot).toBe('/w/repoA/src');
  });
});

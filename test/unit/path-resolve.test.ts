import { describe, expect, it } from 'vitest';
import {
  type IndexedFile,
  type ResolveCtx,
  resolveToken,
  type StatKind,
} from '../../src/path-resolve';

const files: IndexedFile[] = [
  { rel: 'src/core/theme/accent.ts', abs: '/repo/src/core/theme/accent.ts' },
  { rel: 'src/a/config.ts', abs: '/repo/src/a/config.ts' },
  { rel: 'src/b/config.ts', abs: '/repo/src/b/config.ts' },
  { rel: 'webview/app.tsx', abs: '/repo/webview/app.tsx' },
  { rel: 'README.md', abs: '/repo/README.md' },
];

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  cwd: '/repo',
  root: '/repo',
  files,
  caseSensitive: true,
  ...over,
});

/** stat backed by a set of existing dirs + the index files. */
const makeStat =
  (dirs: string[] = []): StatKind =>
  (abs) => {
    if (dirs.includes(abs)) return 'dir';
    return files.some((f) => f.abs === abs) ? 'file' : null;
  };

describe('resolveToken — rule 1 (exact)', () => {
  it('resolves a bare project-relative path against cwd to exactly one file', () => {
    const r = resolveToken('src/core/theme/accent.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].absPath).toBe('/repo/src/core/theme/accent.ts');
    expect(r.candidates[0].relPath).toBe('src/core/theme/accent.ts');
    expect(r.candidates[0].isDir).toBe(false);
  });

  it('falls back from cwd to project root when cwd is a subdir', () => {
    // cwd is a subdir; the token is repo-root-relative → cwd-join misses, root-join hits.
    const r = resolveToken('webview/app.tsx', ctx({ cwd: '/repo/src' }), makeStat());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].absPath).toBe('/repo/webview/app.tsx');
  });

  it('resolves a directory token as a single dir candidate (isDir)', () => {
    const r = resolveToken('src/core', ctx(), makeStat(['/repo/src/core']));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].isDir).toBe(true);
    expect(r.candidates[0].relPath).toBe('src/core');
  });

  it('an absolute token that exists resolves as-is and never suffix-searches', () => {
    const r = resolveToken('/repo/src/a/config.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].absPath).toBe('/repo/src/a/config.ts');
  });

  it('an absolute token that is missing yields no candidates (no suffix fallback)', () => {
    const r = resolveToken('/nowhere/config.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(0);
  });
});

describe('resolveToken — rule 2 (suffix search)', () => {
  it('a bare filename with one match opens directly', () => {
    const r = resolveToken('accent.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relPath)).toEqual(['src/core/theme/accent.ts']);
  });

  it('an ambiguous filename returns all matches (for the dropdown), shortest-path first', () => {
    const r = resolveToken('config.ts', ctx(), makeStat());
    expect(r.candidates.map((c) => c.relPath)).toEqual(['src/a/config.ts', 'src/b/config.ts']);
  });

  it('matches only on a segment boundary (not a substring of a segment)', () => {
    const r = resolveToken('cent.ts', ctx(), makeStat());
    expect(r.candidates).toHaveLength(0); // accent.ts does NOT end with /cent.ts
  });

  it('a relative suffix that is not exact still suffix-matches', () => {
    const r = resolveToken(
      'theme/accent.ts',
      ctx({ cwd: '/elsewhere', root: '/elsewhere' }),
      makeStat(),
    );
    expect(r.candidates.map((c) => c.relPath)).toEqual(['src/core/theme/accent.ts']);
  });

  it('returns nothing for a filename with no match', () => {
    expect(resolveToken('nope.ts', ctx(), makeStat()).candidates).toHaveLength(0);
  });
});

describe('resolveToken — cap, truncation, case-sensitivity', () => {
  it('caps candidates and flags truncated', () => {
    const many: IndexedFile[] = Array.from({ length: 5 }, (_, i) => ({
      rel: `d${i}/x.ts`,
      abs: `/repo/d${i}/x.ts`,
    }));
    const r = resolveToken('x.ts', ctx({ files: many, cap: 3 }), () => null);
    expect(r.candidates).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('case-insensitive match when caseSensitive is false (Windows/macOS)', () => {
    const r = resolveToken('ACCENT.TS', ctx({ caseSensitive: false }), makeStat());
    expect(r.candidates.map((c) => c.relPath)).toEqual(['src/core/theme/accent.ts']);
  });

  it('case-SENSITIVE match misses a differently-cased token (Linux)', () => {
    const r = resolveToken('ACCENT.TS', ctx({ caseSensitive: true }), makeStat());
    expect(r.candidates).toHaveLength(0);
  });
});

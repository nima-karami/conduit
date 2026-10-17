import { describe, expect, it } from 'vitest';
import type { PathCandidate, TokenResolution } from '../../src/path-resolve';
import type { PathToken } from '../../webview/terminal-links';
import {
  capTokenKeys,
  linkTargetOf,
  pathLinksOf,
  pathTokenKey,
  type TokenLine,
} from '../../webview/terminal-path-links-at';

const tok = (raw: string, start: number, over: Partial<PathToken> = {}): PathToken => ({
  raw,
  alts: [raw],
  start,
  end: start + raw.length,
  ...over,
});
const CAND: PathCandidate = {
  absPath: '/w/x.ts',
  rootIdx: 0,
  relToRoot: 'x.ts',
  repoRoot: '/w',
  relToRepo: 'x.ts',
  isDir: false,
  strength: 'exact-root',
};
const found = (key: string, over: Partial<TokenResolution> = {}) => ({
  res: { key, candidates: [CAND], truncated: false, total: 1, ...over },
});
const resolvedAll = (lines: TokenLine[]) =>
  new Map(lines.flatMap((l) => l.tokens.map((t) => [pathTokenKey(t), found(pathTokenKey(t))])));

describe('capTokenKeys — Open Detected Link keeps the newest lines (QA r1 D1)', () => {
  const screen = (n: number): TokenLine[] =>
    Array.from({ length: n }, (_, i) => ({ firstRow: i, tokens: [tok(`src/f${i}.ts`, 0)] }));

  it('14 lines in screen order → the bottom 10, newest first, truncated', () => {
    const { keys, truncated } = capTokenKeys(screen(14), 10);
    expect(keys).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4].map((i) => `src/f${i}.ts`));
    expect(truncated).toBe(true);
    expect(capTokenKeys(screen(14), 10).total).toBe(14);
  });

  it('exactly the cap → not truncated; a repeated token counts once', () => {
    expect(capTokenKeys(screen(10), 10).truncated).toBe(false);
    const repeated = [...screen(10), { firstRow: 10, tokens: [tok('src/f0.ts', 0)] }];
    expect(capTokenKeys(repeated, 10)).toEqual({
      keys: ['src/f0.ts', ...[9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => `src/f${i}.ts`)],
      truncated: false,
      total: 10,
    });
  });

  it('pathLinksOf lists the newest line first, left to right within a line', () => {
    const lines: TokenLine[] = [
      { firstRow: 0, tokens: [tok('a/old.ts', 0)] },
      { firstRow: 1, tokens: [tok('b/new1.ts', 0), tok('b/new2.ts', 12)] },
    ];
    expect(pathLinksOf(lines, resolvedAll(lines), 's').map((l) => l.token)).toEqual([
      'b/new1.ts',
      'b/new2.ts',
      'a/old.ts',
    ]);
  });
});

describe('linkTargetOf — the resolved alt names the link (review r1 SF4)', () => {
  const grouped = tok('app/(g)/x.ts', 0, {
    alts: ['app/(g)/x.ts', 'app/(g)'],
    altEnds: [12, 7],
    line: 3,
  });

  it('alt 1 resolved → its text, its span, and not alt 0 line', () => {
    const t = linkTargetOf(grouped, found('k', { alt: 1 }).res, 'k', 's');
    expect(t.token).toBe('app/(g)');
    expect(t.span).toEqual({ start: 0, end: 7 });
    expect(t.link).toEqual({ key: 'k', scope: 's', line: undefined, col: undefined });
  });

  it('alt 0 → the raw text, the whole span and its line', () => {
    const t = linkTargetOf(grouped, found('k').res, 'k', 's');
    expect(t.token).toBe('app/(g)/x.ts');
    expect(t.span).toEqual({ start: 0, end: 12 });
    expect(t.link.line).toBe(3);
  });
});

describe('pathLinksOf — the provider rule, under a cell too (review r1 nit)', () => {
  it('a cell past the resolved alt span is on no link', () => {
    const t = tok('app/(g)/x.ts', 0, { alts: ['app/(g)/x.ts', 'app/(g)'], altEnds: [12, 7] });
    const resolved = new Map([[pathTokenKey(t), found(pathTokenKey(t), { alt: 1 })]]);
    expect(pathLinksOf([{ firstRow: 0, tokens: [t], at: 9 }], resolved, 's')).toEqual([]);
    expect(
      pathLinksOf([{ firstRow: 0, tokens: [t], at: 3 }], resolved, 's').map((l) => l.token),
    ).toEqual(['app/(g)']);
  });

  it('a token overlapping an earlier link is dropped, even under the cell', () => {
    const long = tok('src/a.ts', 0);
    const inner = tok('a.ts', 4);
    const lines = [{ firstRow: 0, tokens: [long, inner], at: 5 }];
    expect(pathLinksOf(lines, resolvedAll(lines), 's').map((l) => l.token)).toEqual(['src/a.ts']);
  });

  it('a cell past the earlier link is still on no link when its token overlaps that link', () => {
    const first = tok('x/a.ts', 0);
    const later = tok('a.ts/b/c', 2);
    const lines = [{ firstRow: 0, tokens: [first, later], at: 8 }];
    expect(pathLinksOf(lines, resolvedAll(lines), 's')).toEqual([]);
  });

  it('an unresolved earlier token takes no span, so the later one links', () => {
    const long = tok('src/a.ts', 0);
    const inner = tok('a.ts', 4);
    const resolved = new Map([
      [pathTokenKey(long), found(pathTokenKey(long), { candidates: [] })],
      [pathTokenKey(inner), found(pathTokenKey(inner))],
    ]);
    const lines = [{ firstRow: 0, tokens: [long, inner], at: 5 }];
    expect(pathLinksOf(lines, resolved, 's').map((l) => l.token)).toEqual(['a.ts']);
  });
});

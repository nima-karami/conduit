import { describe, expect, it } from 'vitest';
import { computeFileReview, type FileReview, type ReviewLine } from '../../src/review-hunks';
import {
  collectMatches,
  fileFilterMatches,
  MAX_REVIEW_MATCHES,
  matchCountLabel,
  partialLabel,
  type ReviewSearchFile,
  stepMatch,
} from '../../webview/review-search';

const line = (seq: number, text: string): ReviewLine => ({
  kind: 'add',
  text,
  oldLine: null,
  newLine: seq + 1,
  seq,
});

const review = (...texts: string[]): FileReview => ({
  hunks: [{ startNewLine: 1, startOldLine: null, lines: texts.map((t, i) => line(i, t)) }],
  folds: [],
  added: texts.length,
  removed: 0,
});

const file = (path: string, r: FileReview | null): ReviewSearchFile => ({ path, review: r });

describe('collectMatches', () => {
  it('walks files in list order and reports the line seq the row carries', () => {
    const res = collectMatches(
      [file('a.ts', review('const needle = 1;', 'other')), file('b.ts', review('two needle here'))],
      'needle',
    );
    expect(res.matches.map((m) => [m.path, m.seq, m.start])).toEqual([
      ['a.ts', 0, 6],
      ['b.ts', 0, 4],
    ]);
    expect(res.capped).toBe(false);
  });

  it('finds every occurrence on one line, non-overlapping', () => {
    const res = collectMatches([file('a.ts', review('aa aa aa'))], 'aa');
    expect(res.matches.map((m) => m.start)).toEqual([0, 3, 6]);
  });

  it('is case-insensitive by default and exact under caseSensitive', () => {
    const files = [file('a.ts', review('Needle and needle'))];
    expect(collectMatches(files, 'needle').matches).toHaveLength(2);
    expect(collectMatches(files, 'needle', { caseSensitive: true }).matches).toHaveLength(1);
  });

  it('keeps offsets in ORIGINAL-text coordinates past a length-changing uppercase char', () => {
    // 'İ' (U+0130) lowercases to two code points; a lowercased haystack would shift this by +1.
    const text = 'İabc ME';
    expect(text.indexOf('ME')).toBe(5);
    expect(collectMatches([file('a.ts', review(text))], 'me').matches[0]).toMatchObject({
      start: 5,
      end: 7,
    });
  });

  it('treats the query as a literal, not a regex', () => {
    expect(collectMatches([file('a.ts', review('a.c'))], 'a.c').matches).toHaveLength(1);
    expect(collectMatches([file('a.ts', review('abc'))], 'a.c').matches).toHaveLength(0);
  });

  it('returns nothing for an empty query but still reports the file counts', () => {
    const res = collectMatches([file('a.ts', review('x')), file('b.ts', null)], '');
    expect(res.matches).toEqual([]);
    expect([res.loaded, res.total]).toEqual([1, 2]);
  });

  it('skips unloaded files and counts them as unsearched', () => {
    const res = collectMatches(
      [file('a.ts', review('needle')), file('b.ts', null), file('c.ts', null)],
      'needle',
    );
    expect(res.matches).toHaveLength(1);
    expect([res.loaded, res.total]).toEqual([1, 3]);
  });

  it('caps the list and says so', () => {
    const res = collectMatches([file('a.ts', review(...Array(12).fill('needle')))], 'needle', {
      limit: 5,
    });
    expect(res.matches).toHaveLength(5);
    expect(res.capped).toBe(true);
  });

  it('defaults the cap to MAX_REVIEW_MATCHES', () => {
    const many = review(...Array(MAX_REVIEW_MATCHES + 10).fill('needle'));
    const res = collectMatches([file('a.ts', many)], 'needle');
    expect(res.matches).toHaveLength(MAX_REVIEW_MATCHES);
    expect(res.capped).toBe(true);
  });

  it('EXCLUDES folded unchanged context and includes in-hunk context', () => {
    // 40 unchanged lines with the needle up top, then one changed line at the end: the leading
    // run collapses into a fold, so only the hunk's own context can match.
    const head = [...Array(40)].map((_, i) => (i === 2 ? 'const needle = 1;' : `line ${i}`));
    const work = [...head.slice(0, 39), 'changed needle tail'];
    const fr = computeFileReview(`${head.join('\n')}\n`, `${work.join('\n')}\n`);
    expect(fr.folds.length).toBeGreaterThan(0);
    expect(fr.folds.some((f) => f.lines.some((l) => l.text.includes('needle')))).toBe(true);

    const res = collectMatches([file('a.ts', fr)], 'needle');
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].hunkIndex).toBe(0);
  });
});

describe('stepMatch', () => {
  it('wraps forwards and backwards', () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });

  it('seeds from "nothing selected" at either end', () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
  });

  it('has nothing to step through with zero matches', () => {
    expect(stepMatch(-1, 0, 1)).toBe(-1);
    expect(stepMatch(4, 0, -1)).toBe(-1);
  });
});

describe('labels', () => {
  it('renders n / m, marking a capped list', () => {
    expect(matchCountLabel(3, 12, false)).toBe('3 / 12');
    expect(matchCountLabel(1, 2000, true)).toBe('1 / 2000+');
  });

  it('reports partial coverage only while files are unloaded', () => {
    expect(partialLabel(12, 200)).toBe('in 12 of 200 files');
    expect(partialLabel(200, 200)).toBeNull();
    expect(partialLabel(0, 0)).toBeNull();
  });
});

describe('fileFilterMatches', () => {
  it('matches a fuzzy subsequence of the path', () => {
    expect(fileFilterMatches('webview/components/review-view.tsx', 'revview')).toBe(true);
    expect(fileFilterMatches('src/git-exec.ts', 'revview')).toBe(false);
  });

  it('passes everything through for an empty or blank query', () => {
    expect(fileFilterMatches('src/git-exec.ts', '')).toBe(true);
    expect(fileFilterMatches('src/git-exec.ts', '   ')).toBe(true);
  });
});

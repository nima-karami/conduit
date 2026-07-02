import { describe, expect, it } from 'vitest';
import {
  computeReplacementEmphasis,
  type ReviewLine,
  type WordSpan,
  wordDiff,
} from '../../src/review-hunks';

/** Render the changed slices a span list selects out of `text`, for readable assertions. */
const slices = (text: string, spans: WordSpan[]): string[] =>
  spans.map((s) => text.slice(s.start, s.end));

describe('wordDiff', () => {
  it('returns no spans for identical text', () => {
    expect(wordDiff('const a = 1;', 'const a = 1;')).toEqual({ del: [], add: [] });
  });

  it('returns no spans for two empty strings', () => {
    expect(wordDiff('', '')).toEqual({ del: [], add: [] });
  });

  it('marks only the changed token for a one-character edit', () => {
    const oldT = 'const a = 1;';
    const newT = 'const a = 2;';
    const d = wordDiff(oldT, newT);
    expect(slices(oldT, d.del)).toEqual(['1']);
    expect(slices(newT, d.add)).toEqual(['2']);
  });

  it('marks only the changed word, leaving shared words untouched', () => {
    const oldT = 'the quick brown fox';
    const newT = 'the quick red fox';
    const d = wordDiff(oldT, newT);
    expect(slices(oldT, d.del)).toEqual(['brown']);
    expect(slices(newT, d.add)).toEqual(['red']);
  });

  it('marks the whole line when nothing is shared', () => {
    const d = wordDiff('abc', 'xyz');
    expect(d.del).toEqual([{ start: 0, end: 3 }]);
    expect(d.add).toEqual([{ start: 0, end: 3 }]);
  });

  it('is a pure addition when the old string is empty', () => {
    const d = wordDiff('', 'abc');
    expect(d.del).toEqual([]);
    expect(d.add).toEqual([{ start: 0, end: 3 }]);
  });

  it('is a pure deletion when the new string is empty', () => {
    const d = wordDiff('abc', '');
    expect(d.del).toEqual([{ start: 0, end: 3 }]);
    expect(d.add).toEqual([]);
  });

  it('treats a whitespace-only change as a minimal changed span', () => {
    const oldT = 'a b';
    const newT = 'a  b';
    const d = wordDiff(oldT, newT);
    expect(slices(oldT, d.del)).toEqual([' ']);
    expect(slices(newT, d.add)).toEqual(['  ']);
  });

  it('merges adjacent changed tokens into one contiguous span', () => {
    // "foo()" → "bar[]": every token differs and they are contiguous, so a single span each.
    const oldT = 'foo()';
    const newT = 'bar[]';
    const d = wordDiff(oldT, newT);
    expect(d.del).toEqual([{ start: 0, end: 5 }]);
    expect(d.add).toEqual([{ start: 0, end: 5 }]);
  });

  it('produces two separate spans for two separate edits on a line', () => {
    const oldT = 'a = foo + b';
    const newT = 'a = bar + c';
    const d = wordDiff(oldT, newT);
    expect(slices(oldT, d.del)).toEqual(['foo', 'b']);
    expect(slices(newT, d.add)).toEqual(['bar', 'c']);
  });

  it('spans never overlap and stay within bounds', () => {
    const oldT = 'x1 y2 z3';
    const newT = 'x9 y2 z8';
    const d = wordDiff(oldT, newT);
    for (const s of d.del) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeLessThanOrEqual(oldT.length);
      expect(s.start).toBeLessThan(s.end);
    }
    for (let i = 1; i < d.del.length; i++)
      expect(d.del[i].start).toBeGreaterThanOrEqual(d.del[i - 1].end);
  });
});

/** Build a ReviewLine quickly for pairing tests. */
const rl = (kind: ReviewLine['kind'], text: string, seq: number): ReviewLine => ({
  kind,
  text,
  oldLine: kind === 'add' ? null : 1,
  newLine: kind === 'del' ? null : 1,
  seq,
});

describe('computeReplacementEmphasis', () => {
  it('emphasizes the changed word in an adjacent del→add pair', () => {
    const lines: ReviewLine[] = [
      rl('context', 'before', 0),
      rl('del', 'const a = 1;', 1),
      rl('add', 'const a = 2;', 2),
      rl('context', 'after', 3),
    ];
    const map = computeReplacementEmphasis(lines);
    expect(map.get(1)).toEqual([{ start: 10, end: 11 }]);
    expect(map.get(2)).toEqual([{ start: 10, end: 11 }]);
    expect(map.has(0)).toBe(false);
    expect(map.has(3)).toBe(false);
  });

  it('pairs runs index-wise and leaves unpaired lines unemphasized', () => {
    const lines: ReviewLine[] = [rl('del', 'aaa', 0), rl('del', 'bbb', 1), rl('add', 'aaa', 2)];
    // del[0]"aaa" pairs with add[0]"aaa" (identical → no spans); del[1] is unpaired.
    const map = computeReplacementEmphasis(lines);
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(false);
  });

  it('does not emphasize a pure deletion (no following add)', () => {
    const lines: ReviewLine[] = [rl('del', 'gone', 0), rl('context', 'kept', 1)];
    const map = computeReplacementEmphasis(lines);
    expect(map.size).toBe(0);
  });

  it('does not emphasize a pure addition (no preceding del)', () => {
    const lines: ReviewLine[] = [rl('context', 'kept', 0), rl('add', 'new', 1)];
    const map = computeReplacementEmphasis(lines);
    expect(map.size).toBe(0);
  });

  it('skips word-diff on very long lines (perf guard)', () => {
    const long = 'x'.repeat(5000);
    const lines: ReviewLine[] = [rl('del', `${long}a`, 0), rl('add', `${long}b`, 1)];
    const map = computeReplacementEmphasis(lines);
    expect(map.size).toBe(0);
  });
});

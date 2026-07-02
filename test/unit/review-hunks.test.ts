import { describe, expect, it } from 'vitest';
import { computeFileReview, type ReviewLine } from '../../src/review-hunks';

/** Helper: a numbered file of `n` lines, "L1".."Ln". */
const file = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n');

/** Collect the kinds of every line across all hunks, in order. */
const kinds = (head: string, work: string, ctx?: number): ReviewLine['kind'][] =>
  computeFileReview(head, work, ctx).hunks.flatMap((h) => h.lines.map((l) => l.kind));

describe('computeFileReview', () => {
  it('returns no hunks and no folds for identical input', () => {
    const r = computeFileReview('a\nb\nc\n', 'a\nb\nc\n');
    expect(r.hunks).toEqual([]);
    expect(r.folds).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('handles two empty files as identical', () => {
    const r = computeFileReview('', '');
    expect(r.hunks).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('counts a pure addition (new file from empty)', () => {
    const r = computeFileReview('', 'x\ny\n');
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0].lines.every((l) => l.kind === 'add')).toBe(true);
  });

  it('counts a pure deletion (file emptied)', () => {
    const r = computeFileReview('x\ny\n', '');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(2);
    expect(r.hunks[0].lines.every((l) => l.kind === 'del')).toBe(true);
  });

  it('models a single-line modification as a del followed by an add', () => {
    const r = computeFileReview('const a = 1;\n', 'const a = 2;\n');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const ks = r.hunks.flatMap((h) => h.lines.map((l) => l.kind));
    expect(ks).toContain('del');
    expect(ks).toContain('add');
  });

  it('keeps up to `context` lines around a change and folds the rest', () => {
    // 20 unchanged lines, then change line 21 (index), then 20 more unchanged.
    const head = `${file(40)}\n`;
    const lines = file(40).split('\n');
    lines[20] = 'CHANGED';
    const work = `${lines.join('\n')}\n`;
    const r = computeFileReview(head, work, 3);

    expect(r.hunks).toHaveLength(1);
    const hunk = r.hunks[0];
    // 3 leading context + del + add + 3 trailing context = 8 rendered lines.
    expect(hunk.lines).toHaveLength(8);
    expect(hunk.lines.slice(0, 3).every((l) => l.kind === 'context')).toBe(true);
    expect(hunk.lines.slice(-3).every((l) => l.kind === 'context')).toBe(true);

    // Two folds: one before (leading 17 lines hidden) and one after (trailing 16 lines).
    expect(r.folds).toHaveLength(2);
    expect(r.folds[0].index).toBe(0); // before the first hunk
    expect(r.folds[1].index).toBe(1); // after the (only) hunk
    expect(r.folds[0].count).toBe(40 - 1 - 3 - 3 - 16); // leading hidden = 17
    expect(r.folds[0].count).toBe(17);
    expect(r.folds[1].count).toBe(16);
  });

  it('does not fold a short gap between two changes (<= 2*context)', () => {
    // change line 1, 4 unchanged lines, change line 6 — gap of 4 <= 6, so inline.
    const head = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    const work = ['A', 'b', 'c', 'd', 'e', 'F'].join('\n');
    const r = computeFileReview(head, work, 3);
    expect(r.hunks).toHaveLength(1); // single hunk, gap kept inline
    expect(r.folds.filter((f) => f.index === 1)).toHaveLength(0); // no mid fold
  });

  it('splits into two hunks with a fold when the gap exceeds 2*context', () => {
    // change line 1, then 20 unchanged, then change line 22.
    const mid = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const head = ['a', ...mid, 'z'].join('\n');
    const work = ['A', ...mid, 'Z'].join('\n');
    const r = computeFileReview(head, work, 3);
    expect(r.hunks).toHaveLength(2);
    // One fold between the two hunks (index === 1, after first hunk).
    const midFolds = r.folds.filter((f) => f.index === 1);
    expect(midFolds).toHaveLength(1);
    expect(midFolds[0].count).toBe(20 - 3 - 3); // 14 hidden
  });

  it('assigns 1-based old/new line numbers consistently', () => {
    const head = 'a\nb\nc\n';
    const work = 'a\nB\nc\n';
    const r = computeFileReview(head, work, 3);
    const flat = r.hunks.flatMap((h) => h.lines);
    const ctxA = flat.find((l) => l.kind === 'context' && l.text === 'a');
    expect(ctxA?.oldLine).toBe(1);
    expect(ctxA?.newLine).toBe(1);
    const del = flat.find((l) => l.kind === 'del');
    expect(del?.text).toBe('b');
    expect(del?.oldLine).toBe(2);
    expect(del?.newLine).toBeNull();
    const add = flat.find((l) => l.kind === 'add');
    expect(add?.text).toBe('B');
    expect(add?.newLine).toBe(2);
    expect(add?.oldLine).toBeNull();
  });

  it("a hunk's startNewLine points at its first rendered work line", () => {
    const head = `${file(10)}\n`;
    const lines = file(10).split('\n');
    lines[5] = 'CHANGED'; // change L6 (index 5)
    const work = `${lines.join('\n')}\n`;
    const r = computeFileReview(head, work, 2);
    // Leading context starts 2 lines before the change → work line 4.
    expect(r.hunks[0].startNewLine).toBe(4);
  });

  it('respects a custom context of 0 (changed lines only, no surrounding context)', () => {
    const head = `${file(10)}\n`;
    const lines = file(10).split('\n');
    lines[4] = 'CHANGED';
    const work = `${lines.join('\n')}\n`;
    const r = computeFileReview(head, work, 0);
    const ks = kinds(head, work, 0);
    expect(ks).not.toContain('context');
    // Folds before and after capture all unchanged lines.
    expect(r.folds.reduce((a, f) => a + f.count, 0)).toBe(9);
  });

  it('treats a file with no trailing newline the same as one with it', () => {
    const withNl = computeFileReview('a\nb\n', 'a\nB\n');
    const withoutNl = computeFileReview('a\nb', 'a\nB');
    expect(withNl.added).toBe(withoutNl.added);
    expect(withNl.removed).toBe(withoutNl.removed);
    expect(withNl.hunks.length).toBe(withoutNl.hunks.length);
  });

  it('ignores CRLF/LF line-ending differences, surfacing only real content changes', () => {
    // On Windows with core.autocrlf=true the working file is CRLF while
    // `git show HEAD:<rel>` returns LF-normalized content. Only line 2 truly changed.
    const head = 'a\nb\nc\n';
    const work = 'a\r\nB\r\nc\r\n';
    const r = computeFileReview(head, work, 3);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const flat = r.hunks.flatMap((h) => h.lines);
    expect(flat.filter((l) => l.kind === 'context').map((l) => l.text)).toEqual(['a', 'c']);
    const del = flat.find((l) => l.kind === 'del');
    const add = flat.find((l) => l.kind === 'add');
    expect(del?.text).toBe('b');
    expect(add?.text).toBe('B');
  });

  it('treats a pure CRLF-vs-LF change as no change at all', () => {
    const r = computeFileReview('a\nb\nc\n', 'a\r\nb\r\nc\r\n');
    expect(r.hunks).toEqual([]);
    expect(r.folds).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('handles multiple separated changes across a larger file', () => {
    const base = file(60).split('\n');
    const work = [...base];
    work[5] = 'X';
    work[30] = 'Y';
    work[55] = 'Z';
    const r = computeFileReview(base.join('\n'), work.join('\n'), 3);
    expect(r.hunks).toHaveLength(3);
    expect(r.added).toBe(3);
    expect(r.removed).toBe(3);
  });
});

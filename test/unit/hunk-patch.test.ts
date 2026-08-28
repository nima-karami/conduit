import { describe, expect, it } from 'vitest';
import {
  type HunkRange,
  hunkRange,
  parseUnifiedDiff,
  selectHunks,
  spansOverlap,
} from '../../src/hunk-patch';
import { computeFileReview } from '../../src/review-hunks';

/** Two separate hunks in one file, LF throughout. */
const TWO_HUNKS = [
  'diff --git a/two.txt b/two.txt',
  'index 1111111..2222222 100644',
  '--- a/two.txt',
  '+++ b/two.txt',
  '@@ -1,5 +1,6 @@',
  ' l1',
  ' l2',
  '+ADDED-A',
  ' l3',
  ' l4',
  ' l5',
  '@@ -18,6 +19,6 @@',
  ' l18',
  ' l19',
  ' l20',
  '-l21',
  '+CHANGED-B',
  ' l22',
  ' l23',
  '',
].join('\n');

const range = (n: [number, number], o: [number, number]): HunkRange => ({ new: n, old: o });

describe('parseUnifiedDiff', () => {
  it('splits the file header from the hunks and re-reads both @@ headers', () => {
    const p = parseUnifiedDiff(TWO_HUNKS);
    expect(p.binary).toBe(false);
    expect(p.header).toBe(
      'diff --git a/two.txt b/two.txt\nindex 1111111..2222222 100644\n--- a/two.txt\n+++ b/two.txt\n',
    );
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 5, newStart: 1, newCount: 6 });
    expect(p.hunks[1]).toMatchObject({ oldStart: 18, oldCount: 6, newStart: 19, newCount: 6 });
  });

  it('spans only the CHANGED lines, not the context the @@ header covers', () => {
    const p = parseUnifiedDiff(TWO_HUNKS);
    // Hunk 1 adds new line 3 only; nothing is removed.
    expect(p.hunks[0].changedNew).toEqual([3, 3]);
    expect(p.hunks[0].changedOld).toEqual([3, 2]); // empty, anchored where the insertion sits
    // Hunk 2 replaces old 21 with new 22.
    expect(p.hunks[1].changedNew).toEqual([22, 22]);
    expect(p.hunks[1].changedOld).toEqual([21, 21]);
  });

  it('keeps every hunk body line verbatim, trailing newline included', () => {
    const p = parseUnifiedDiff(TWO_HUNKS);
    expect(p.hunks[0].text).toBe('@@ -1,5 +1,6 @@\n l1\n l2\n+ADDED-A\n l3\n l4\n l5\n');
    expect(`${p.header}${p.hunks[0].text}${p.hunks[1].text}`).toBe(TWO_HUNKS);
  });

  it('treats a missing count as 1', () => {
    const p = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -4 +4 @@\n-a\n+b\n');
    expect(p.hunks[0]).toMatchObject({ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 });
  });

  it('keeps CR bytes as content — \\n is the only separator', () => {
    const crlf = '--- a/x\r\n+++ b/x\r\n@@ -1,1 +1,1 @@\n-one\r\n+two\r\n';
    const p = parseUnifiedDiff(crlf);
    expect(p.header).toBe('--- a/x\r\n+++ b/x\r\n');
    expect(p.hunks[0].text).toBe('@@ -1,1 +1,1 @@\n-one\r\n+two\r\n');
  });

  it('keeps the no-newline-at-EOF marker inside its hunk', () => {
    const src = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n';
    const p = parseUnifiedDiff(src);
    expect(p.hunks[0].text).toContain('\\ No newline at end of file\n');
    // The marker line is not a content line: it must not advance either side's counter.
    expect(p.hunks[0].changedOld).toEqual([1, 1]);
    expect(p.hunks[0].changedNew).toEqual([1, 1]);
  });

  it('reads a rename header without inventing a hunk', () => {
    const src = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 87%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+two',
      '',
    ].join('\n');
    const p = parseUnifiedDiff(src);
    expect(p.header).toContain('rename from old.txt\n');
    expect(p.header).toContain('rename to new.txt\n');
    expect(p.hunks).toHaveLength(1);
  });

  it('flags a binary diff and yields no hunks', () => {
    const p = parseUnifiedDiff(
      'diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n',
    );
    expect(p.binary).toBe(true);
    expect(p.hunks).toEqual([]);
  });

  it('flags a GIT binary patch', () => {
    expect(parseUnifiedDiff('diff --git a/x b/x\nGIT binary patch\nliteral 4\n').binary).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({ header: '', hunks: [], binary: false });
  });
});

describe('spansOverlap', () => {
  it('is true for touching and overlapping spans', () => {
    expect(spansOverlap([3, 5], [5, 9])).toBe(true);
    expect(spansOverlap([3, 5], [1, 3])).toBe(true);
    expect(spansOverlap([3, 5], [4, 4])).toBe(true);
  });

  it('is false for disjoint spans', () => {
    expect(spansOverlap([3, 5], [6, 9])).toBe(false);
  });

  it('an empty span (end < start) intersects nothing, including itself', () => {
    expect(spansOverlap([5, 4], [1, 10])).toBe(false);
    expect(spansOverlap([1, 10], [5, 4])).toBe(false);
    expect(spansOverlap([5, 4], [5, 4])).toBe(false);
  });
});

describe('selectHunks', () => {
  it('keeps only the hunk the new-side range touches, with the file header verbatim', () => {
    const patch = selectHunks(TWO_HUNKS, range([22, 22], [21, 21]));
    expect(patch).toBe(
      'diff --git a/two.txt b/two.txt\nindex 1111111..2222222 100644\n--- a/two.txt\n+++ b/two.txt\n' +
        '@@ -18,6 +19,6 @@\n l18\n l19\n l20\n-l21\n+CHANGED-B\n l22\n l23\n',
    );
  });

  it('keeps the other hunk for the other range', () => {
    const patch = selectHunks(TWO_HUNKS, range([3, 3], [3, 2]));
    expect(patch).toContain('@@ -1,5 +1,6 @@');
    expect(patch).not.toContain('@@ -18,6 +19,6 @@');
  });

  it('applies BOTH when the range spans two git hunks (spec §4)', () => {
    const patch = selectHunks(TWO_HUNKS, range([1, 40], [1, 40]));
    expect(patch).toContain('@@ -1,5 +1,6 @@');
    expect(patch).toContain('@@ -18,6 +19,6 @@');
  });

  it('does not select a hunk the range only touches through its context', () => {
    // New lines 1-2 are hunk 1's leading CONTEXT; its only changed line is 3.
    expect(selectHunks(TWO_HUNKS, range([1, 2], [1, 2]))).toBe('');
  });

  it('matches a pure-deletion hunk on the old side when the new span is empty', () => {
    const src = '--- a/x\n+++ b/x\n@@ -4,5 +4,3 @@\n c3\n-d4\n-d5\n c6\n c7\n c8\n';
    // A deletion anchored after new line 4: new span empty at 5, old span 5-6.
    const patch = selectHunks(src, range([5, 4], [5, 6]));
    expect(patch).toContain('@@ -4,5 +4,3 @@');
  });

  it('returns an empty patch for a binary diff', () => {
    const src = 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n';
    expect(selectHunks(src, range([1, 10], [1, 10]))).toBe('');
  });

  it('returns an empty patch when nothing intersects', () => {
    expect(selectHunks(TWO_HUNKS, range([900, 910], [900, 910]))).toBe('');
  });

  it('returns an empty patch for an empty diff', () => {
    expect(selectHunks('', range([1, 1], [1, 1]))).toBe('');
  });

  it('preserves CRLF and the no-EOF marker in what it re-emits', () => {
    const src = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\r\n+two\r\n\\ No newline at end of file\n';
    expect(selectHunks(src, range([1, 1], [1, 1]))).toBe(src);
  });
});

describe('hunkRange', () => {
  const lines = (n: number, prefix = 'l') =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');

  it('spans the changed lines of a replacement on both sides', () => {
    const review = computeFileReview(lines(10), lines(10).replace('l5', 'CHANGED'));
    expect(hunkRange(review.hunks[0])).toEqual({ new: [5, 5], old: [5, 5] });
  });

  it('gives a pure insertion an empty old span anchored after the previous old line', () => {
    const head = lines(10);
    const work = `${lines(5)}\nNEW1\nNEW2\n${['l6', 'l7', 'l8', 'l9', 'l10'].join('\n')}`;
    const r = hunkRange(computeFileReview(head, work).hunks[0]);
    expect(r.new).toEqual([6, 7]);
    expect(r.old[1]).toBeLessThan(r.old[0]);
    expect(r.old[0]).toBe(6);
  });

  it('gives a pure deletion an empty new span and a real old span', () => {
    const work = ['l1', 'l2', 'l3', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const r = hunkRange(computeFileReview(lines(10), work).hunks[0]);
    expect(r.old).toEqual([4, 5]);
    expect(r.new[1]).toBeLessThan(r.new[0]);
    expect(r.new[0]).toBe(4);
  });

  it('spans every run when one Review hunk holds two of them', () => {
    // A 4-line unchanged gap is <= 2*context, so both runs stay in ONE hunk.
    const r = hunkRange(
      computeFileReview(lines(12), lines(12).replace('l4', 'A').replace('l9', 'B')).hunks[0],
    );
    expect(r.new).toEqual([4, 9]);
    expect(r.old).toEqual([4, 9]);
  });
});

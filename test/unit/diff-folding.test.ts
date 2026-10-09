import { describe, expect, it } from 'vitest';
import { diffFoldingRanges } from '../../webview/diff-folding';

describe('diffFoldingRanges', () => {
  it('folds each file and each hunk of a git patch', () => {
    const lines = [
      'diff --git a/x b/x', // 1
      'index 1..2 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@', // 5
      '-a',
      '+b',
      '@@ -9,1 +9,2 @@', // 8
      ' c',
      '+d',
      'diff --git a/y b/y', // 11
      '--- a/y',
      '+++ b/y',
      '@@ -1 +1 @@', // 14
      '-e',
      '+f',
    ];
    const ranges = diffFoldingRanges(lines);
    expect(ranges).toHaveLength(5);
    expect(ranges).toEqual(
      expect.arrayContaining([
        { start: 1, end: 10 },
        { start: 11, end: 16 },
        { start: 5, end: 7 },
        { start: 8, end: 10 },
        { start: 14, end: 16 },
      ]),
    );
  });

  it('gives only hunk ranges for a plain ---/+++/@@ patch', () => {
    expect(diffFoldingRanges(['--- a', '+++ b', '@@ -1 +1 @@', '-x', '+y'])).toEqual([
      { start: 3, end: 5 },
    ]);
  });

  it('omits a single-line hunk or file', () => {
    expect(diffFoldingRanges(['@@ -1 +1 @@', '@@ -2 +2 @@', ' x'])).toEqual([{ start: 2, end: 3 }]);
    expect(diffFoldingRanges(['diff --git a/x b/x'])).toEqual([]);
  });

  it('gives nothing for text that is not a patch', () => {
    expect(diffFoldingRanges(['hello', 'world'])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { diff } from '../../webview/diff-grammar';
import { tokenizeLines } from './grammar-runner';

const line = (text: string) => tokenizeLines(diff, [text])[0];

describe('diff grammar', () => {
  it('reads the file headers as keywords', () => {
    for (const h of ['diff --git a/x b/x', 'index 83db48f..bf269f4 100644', '--- a/x', '+++ b/x']) {
      expect(line(h), h).toEqual([[h, 'keyword']]);
    }
  });

  it('reads the @@ range as type and leaves the trailing context plain', () => {
    expect(line('@@ -1,2 +1,3 @@ ctx')).toEqual([['@@ -1,2 +1,3 @@', 'type']]);
    expect(line('@@ -0,0 +1 @@')).toEqual([['@@ -0,0 +1 @@', 'type']]);
  });

  it('reads added, removed and no-newline lines whole', () => {
    expect(line('+x = "a" // b')).toEqual([['+x = "a" // b', 'string']]);
    expect(line('-x')).toEqual([['-x', 'log-error']]);
    expect(line('\\ No newline at end of file')).toEqual([
      ['\\ No newline at end of file', 'comment'],
    ]);
  });

  it('leaves context and everything else plain', () => {
    expect(line(' ctx')).toEqual([]);
    expect(line('Some commit message')).toEqual([]);
    expect(tokenizeLines(diff, ['', ' a', ''])).toEqual([[], [], []]);
  });

  it('matches only at column 0: a "+" or "@@" mid-line is not a marker', () => {
    expect(line(' a + b @@ c')).toEqual([]);
  });

  it('reads a removed "-- x" and an added "++x" inside a hunk as lines, not headers', () => {
    expect(tokenizeLines(diff, ['@@ -1,2 +1,2 @@', '--- sql comment', '+++x', ' ctx'])).toEqual([
      [['@@ -1,2 +1,2 @@', 'type']],
      [['--- sql comment', 'log-error']],
      [['+++x', 'string']],
      [],
    ]);
  });

  it('leaves the hunk at the next file header', () => {
    expect(
      tokenizeLines(diff, ['@@ -1 +1 @@', '-a', 'diff --git a/y b/y', '--- a/y', '+++ b/y']).slice(
        2,
      ),
    ).toEqual([
      [['diff --git a/y b/y', 'keyword']],
      [['--- a/y', 'keyword']],
      [['+++ b/y', 'keyword']],
    ]);
  });

  it('reads a combined-diff @@@ range as type', () => {
    expect(line('@@@ -1,2 -1,2 +1,3 @@@ x')).toEqual([['@@@ -1,2 -1,2 +1,3 @@@', 'type']]);
  });
});

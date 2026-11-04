import { describe, expect, it } from 'vitest';
import type { DocKind } from '../../webview/docs';
import { shownFilePaths } from '../../webview/watched-files';

const doc = (kind: DocKind, path: string, sessionId: string) => ({ kind, path, sessionId });

describe('shownFilePaths', () => {
  it('only file docs of shown sessions, deduped and sorted', () => {
    const docs = [
      doc('file', '/w/b.ts', 's1'),
      doc('file', '/w/a.ts', 's1'),
      doc('file', '/w/a.ts', 's2'),
      doc('file', '/w/hidden.ts', 's3'),
      doc('diff', '/w/d.ts', 's1'),
      doc('review', '/w/r', 's1'),
      doc('web', 'https://x', 's1'),
    ];
    expect(shownFilePaths(docs, ['s1', 's2'])).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it('empty when nothing is shown', () => {
    expect(shownFilePaths([doc('file', '/w/a.ts', 's1')], [])).toEqual([]);
  });
});

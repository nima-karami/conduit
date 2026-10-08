import { describe, expect, it } from 'vitest';
import { markdownFoldingRanges } from '../../webview/markdown-folding';

const fold = (src: string) => markdownFoldingRanges(src.split('\n'));

describe('markdownFoldingRanges', () => {
  it('folds a section to the line before the next heading of the same or higher level', () => {
    const doc = [
      '# A', //       1
      'intro', //     2
      '## B', //      3
      'b body', //    4
      '### B.1', //   5
      'deep', //      6
      '## C', //      7
      'c body', //    8
      '# D', //       9
      'd', //         10
    ].join('\n');
    expect(fold(doc)).toEqual([
      { start: 1, end: 8 },
      { start: 3, end: 6 },
      { start: 5, end: 6 },
      { start: 7, end: 8 },
      { start: 9, end: 10 },
    ]);
  });

  it('leaves trailing blank lines outside a section', () => {
    expect(fold('## A\ntext\n\n\n## B\nmore\n')).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
  });

  it('does not fold a heading with no body', () => {
    expect(fold('## A\n## B\nx')).toEqual([{ start: 2, end: 3 }]);
  });

  it('ignores a # inside a fenced block, and folds the fence itself', () => {
    expect(fold('## A\n```sh\n# not a heading\necho\n```\ntail')).toEqual([
      { start: 1, end: 6 },
      { start: 2, end: 5 },
    ]);
    expect(fold('~~~\n# x\n~~~')).toEqual([{ start: 1, end: 3 }]);
  });

  it('needs a space after the hashes and at most six of them', () => {
    expect(fold('#hashtag\nx\n####### seven\ny')).toEqual([]);
  });

  it('folds region markers as regions', () => {
    expect(fold('<!-- #region notes -->\na\nb\n<!-- #endregion -->')).toEqual([
      { start: 1, end: 4, kind: 'region' },
    ]);
  });

  it('keeps an unterminated fence from swallowing headings forever', () => {
    expect(fold('```\n# a\nb')).toEqual([]);
  });
});

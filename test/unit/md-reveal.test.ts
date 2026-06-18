import { describe, expect, it } from 'vitest';
import { findBlockForLine, rehypeHeadingIds } from '../../webview/md-reveal';

describe('findBlockForLine', () => {
  it('returns -1 for an empty block list', () => {
    expect(findBlockForLine([], 5)).toBe(-1);
  });

  it('returns 0 when target is before the first block', () => {
    const blocks = [{ sourceLine: 3 }, { sourceLine: 7 }, { sourceLine: 12 }];
    expect(findBlockForLine(blocks, 1)).toBe(0);
  });

  it('returns the block that exactly matches the target line', () => {
    const blocks = [{ sourceLine: 1 }, { sourceLine: 5 }, { sourceLine: 10 }];
    expect(findBlockForLine(blocks, 5)).toBe(1);
  });

  it('returns the last block whose sourceLine is before the target', () => {
    const blocks = [{ sourceLine: 1 }, { sourceLine: 5 }, { sourceLine: 10 }];
    // Line 7 is between block 1 (line 5) and block 2 (line 10) — returns block 1
    expect(findBlockForLine(blocks, 7)).toBe(1);
  });

  it('returns the last block index when target exceeds all blocks', () => {
    const blocks = [{ sourceLine: 1 }, { sourceLine: 5 }, { sourceLine: 10 }];
    expect(findBlockForLine(blocks, 99)).toBe(2);
  });

  it('returns 0 for a single block regardless of target line', () => {
    const blocks = [{ sourceLine: 3 }];
    expect(findBlockForLine(blocks, 1)).toBe(0);
    expect(findBlockForLine(blocks, 3)).toBe(0);
    expect(findBlockForLine(blocks, 100)).toBe(0);
  });

  it('handles adjacent blocks — picks the exact match over the preceding one', () => {
    const blocks = [{ sourceLine: 1 }, { sourceLine: 2 }, { sourceLine: 3 }];
    expect(findBlockForLine(blocks, 2)).toBe(1);
    expect(findBlockForLine(blocks, 3)).toBe(2);
  });

  it('works with a realistic markdown structure', () => {
    // h1 at line 1, paragraph at 3, h2 at 7, list at 9, pre at 13
    const blocks = [
      { sourceLine: 1 },
      { sourceLine: 3 },
      { sourceLine: 7 },
      { sourceLine: 9 },
      { sourceLine: 13 },
    ];
    // Target is inside the list (line 10) — should map to block 3 (list)
    expect(findBlockForLine(blocks, 10)).toBe(3);
    // Target is inside the pre (line 15)
    expect(findBlockForLine(blocks, 15)).toBe(4);
    // Target is line 1 — the heading itself
    expect(findBlockForLine(blocks, 1)).toBe(0);
    // Target is before anything (shouldn't happen in practice, but test it)
    expect(findBlockForLine(blocks, 0)).toBe(0);
  });
});

describe('rehypeHeadingIds', () => {
  // Minimal HAST builders matching the subset the plugin walks.
  const text = (value: string) => ({ type: 'text', value });
  const el = (tagName: string, children: unknown[], properties = {}) => ({
    type: 'element',
    tagName,
    properties,
    children,
  });
  const root = (children: unknown[]) => ({ type: 'root', children });

  it('stamps a slugified id on headings from their text', () => {
    // biome-ignore lint/suspicious/noExplicitAny: loose HAST fixtures
    const tree: any = root([el('h1', [text('Hello World')]), el('h2', [text('Sub Section')])]);
    rehypeHeadingIds()(tree);
    expect(tree.children[0].properties.id).toBe('hello-world');
    expect(tree.children[1].properties.id).toBe('sub-section');
  });

  it('dedups duplicate heading text within one pass', () => {
    // biome-ignore lint/suspicious/noExplicitAny: loose HAST fixtures
    const tree: any = root([el('h2', [text('Notes')]), el('h2', [text('Notes')])]);
    rehypeHeadingIds()(tree);
    expect(tree.children[0].properties.id).toBe('notes');
    expect(tree.children[1].properties.id).toBe('notes-1');
  });

  it('concatenates text across inline markup', () => {
    // biome-ignore lint/suspicious/noExplicitAny: loose HAST fixtures
    const tree: any = root([el('h3', [text('A '), el('code', [text('B')]), text(' C')])]);
    rehypeHeadingIds()(tree);
    expect(tree.children[0].properties.id).toBe('a-b-c');
  });

  it('respects an existing id and skips empty headings', () => {
    // biome-ignore lint/suspicious/noExplicitAny: loose HAST fixtures
    const tree: any = root([el('h1', [text('Keep')], { id: 'custom' }), el('h1', [])]);
    rehypeHeadingIds()(tree);
    expect(tree.children[0].properties.id).toBe('custom');
    expect(tree.children[1].properties.id).toBeUndefined();
  });
});

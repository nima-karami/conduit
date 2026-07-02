import { describe, expect, it } from 'vitest';
import {
  buildTocEntries,
  type HeadingInfo,
  pickActiveIndex,
  tocIdsWithChildren,
  visibleTocEntries,
} from '../../webview/md-toc';

const h = (level: number, id: string, text: string): HeadingInfo => ({ level, id, text });
const entries = (...ds: [string, number][]) =>
  ds.map(([id, depth]) => ({ id, text: id.toUpperCase(), level: depth + 1, depth }));

describe('tocIdsWithChildren', () => {
  it('flags an entry whose next entry is deeper', () => {
    const s = tocIdsWithChildren(entries(['a', 0], ['b', 1], ['c', 0]));
    expect([...s]).toEqual(['a']);
  });
  it('flags nothing for a flat list', () => {
    expect(tocIdsWithChildren(entries(['a', 0], ['b', 0])).size).toBe(0);
  });
});

describe('visibleTocEntries', () => {
  const list = entries(['a', 0], ['b', 1], ['c', 2], ['d', 1], ['e', 0]);
  it('returns all when nothing is collapsed', () => {
    expect(visibleTocEntries(list, new Set()).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('hides the whole subtree of a collapsed ancestor', () => {
    expect(visibleTocEntries(list, new Set(['a'])).map((e) => e.id)).toEqual(['a', 'e']);
  });
  it('collapses one branch while a sibling stays visible', () => {
    expect(visibleTocEntries(list, new Set(['b'])).map((e) => e.id)).toEqual(['a', 'b', 'd', 'e']);
  });
  it('handles nested collapsed ancestors', () => {
    expect(visibleTocEntries(list, new Set(['a', 'b'])).map((e) => e.id)).toEqual(['a', 'e']);
  });
});

describe('buildTocEntries', () => {
  it('builds entries with depth relative to the shallowest heading', () => {
    const entries = buildTocEntries([h(2, 'a', 'A'), h(3, 'b', 'B'), h(2, 'c', 'C')]);
    expect(entries.map((e) => [e.id, e.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
  });

  it('drops headings without an id or with empty text', () => {
    const entries = buildTocEntries([h(1, '', 'no id'), h(1, 'ok', 'Has id'), h(1, 'blank', '  ')]);
    expect(entries.map((e) => e.id)).toEqual(['ok']);
  });

  it('trims whitespace from text', () => {
    expect(buildTocEntries([h(1, 'x', '  Title  ')])[0].text).toBe('Title');
  });

  it('returns [] for empty input', () => {
    expect(buildTocEntries([])).toEqual([]);
  });
});

describe('pickActiveIndex', () => {
  const tops = [0, 100, 250, 500];
  // Tall enough that the reading-line cases below never trip the bottom-out branch.
  const tall = 100_000;

  it('selects the last heading at/above the reading line', () => {
    expect(pickActiveIndex(tops, 0, 80, tall, 600)).toBe(0);
    expect(pickActiveIndex(tops, 120, 80, tall, 600)).toBe(1); // line=200 -> heading at 100
    expect(pickActiveIndex(tops, 200, 80, tall, 600)).toBe(2); // line=280 -> heading at 250
    expect(pickActiveIndex(tops, 1000, 80, tall, 600)).toBe(3);
  });

  it('treats the first heading as active at the very top (no empty flash)', () => {
    expect(pickActiveIndex(tops, 0, 0, tall, 600)).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(pickActiveIndex([], 100, 80, tall, 600)).toBe(-1);
  });

  it('activates the last heading when bottomed out, even if its top is below the line', () => {
    // Short final section: its top (500) never reaches the reading line because the
    // container bottoms out first (scrollHeight 700, clientHeight 600 -> max scrollTop 100).
    expect(pickActiveIndex(tops, 100, 80, 700, 600)).toBe(3);
    // Within ~2px of the bottom still counts as bottomed out.
    expect(pickActiveIndex(tops, 98, 80, 700, 600)).toBe(3);
  });
});

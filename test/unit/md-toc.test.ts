import { describe, expect, it } from 'vitest';
import { buildTocEntries, type HeadingInfo, pickActiveIndex } from '../../webview/md-toc';

const h = (level: number, id: string, text: string): HeadingInfo => ({ level, id, text });

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

  it('selects the last heading at/above the reading line', () => {
    expect(pickActiveIndex(tops, 0, 80)).toBe(0);
    expect(pickActiveIndex(tops, 120, 80)).toBe(1); // line=200 -> heading at 100
    expect(pickActiveIndex(tops, 200, 80)).toBe(2); // line=280 -> heading at 250
    expect(pickActiveIndex(tops, 1000, 80)).toBe(3);
  });

  it('treats the first heading as active at the very top (no empty flash)', () => {
    expect(pickActiveIndex(tops, 0, 0)).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(pickActiveIndex([], 100, 80)).toBe(-1);
  });
});

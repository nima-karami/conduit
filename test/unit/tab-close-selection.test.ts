import { describe, expect, it } from 'vitest';
import { closeTabSelection } from '../../webview/tab-close-selection';

const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

describe('closeTabSelection – close', () => {
  it('returns only the anchor', () => {
    expect(closeTabSelection(paths, 'c.ts', 'close')).toEqual(['c.ts']);
  });
  it('returns the anchor when it is the first tab', () => {
    expect(closeTabSelection(paths, 'a.ts', 'close')).toEqual(['a.ts']);
  });
  it('returns the anchor when it is the last tab', () => {
    expect(closeTabSelection(paths, 'e.ts', 'close')).toEqual(['e.ts']);
  });
  it('returns empty array when anchor not found', () => {
    expect(closeTabSelection(paths, 'z.ts', 'close')).toEqual([]);
  });
});

describe('closeTabSelection – right', () => {
  it('returns paths after the anchor', () => {
    expect(closeTabSelection(paths, 'c.ts', 'right')).toEqual(['d.ts', 'e.ts']);
  });
  it('returns empty when anchor is last tab', () => {
    expect(closeTabSelection(paths, 'e.ts', 'right')).toEqual([]);
  });
  it('returns all but first when anchor is first tab', () => {
    expect(closeTabSelection(paths, 'a.ts', 'right')).toEqual(['b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });
  it('returns empty when anchor not found', () => {
    expect(closeTabSelection(paths, 'z.ts', 'right')).toEqual([]);
  });
  it('returns correct subset for second-to-last tab', () => {
    expect(closeTabSelection(paths, 'd.ts', 'right')).toEqual(['e.ts']);
  });
});

describe('closeTabSelection – left', () => {
  it('returns paths before the anchor', () => {
    expect(closeTabSelection(paths, 'c.ts', 'left')).toEqual(['a.ts', 'b.ts']);
  });
  it('returns empty when anchor is first tab', () => {
    expect(closeTabSelection(paths, 'a.ts', 'left')).toEqual([]);
  });
  it('returns all but last when anchor is last tab', () => {
    expect(closeTabSelection(paths, 'e.ts', 'left')).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
  it('returns empty when anchor not found', () => {
    expect(closeTabSelection(paths, 'z.ts', 'left')).toEqual([]);
  });
  it('returns correct subset for second tab', () => {
    expect(closeTabSelection(paths, 'b.ts', 'left')).toEqual(['a.ts']);
  });
});

describe('closeTabSelection – others', () => {
  it('returns all paths except anchor', () => {
    expect(closeTabSelection(paths, 'c.ts', 'others')).toEqual(['a.ts', 'b.ts', 'd.ts', 'e.ts']);
  });
  it('returns empty when single tab is the anchor', () => {
    expect(closeTabSelection(['only.ts'], 'only.ts', 'others')).toEqual([]);
  });
  it('returns empty when anchor not found', () => {
    expect(closeTabSelection(paths, 'z.ts', 'others')).toEqual([]);
  });
  it('returns all others when anchor is first', () => {
    expect(closeTabSelection(paths, 'a.ts', 'others')).toEqual(['b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });
  it('returns all others when anchor is last', () => {
    expect(closeTabSelection(paths, 'e.ts', 'others')).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
});

describe('closeTabSelection – all', () => {
  it('returns every path', () => {
    expect(closeTabSelection(paths, 'c.ts', 'all')).toEqual(paths);
  });
  it('returns a copy, not the same reference', () => {
    const result = closeTabSelection(paths, 'a.ts', 'all');
    expect(result).not.toBe(paths);
    expect(result).toEqual([...paths]);
  });
  it('returns empty array for empty input', () => {
    expect(closeTabSelection([], 'a.ts', 'all')).toEqual([]);
  });
  it('returns single tab', () => {
    expect(closeTabSelection(['only.ts'], 'only.ts', 'all')).toEqual(['only.ts']);
  });
  it('returns all even when anchor is not found', () => {
    expect(closeTabSelection(paths, 'z.ts', 'all')).toEqual([...paths]);
  });
});

describe('closeTabSelection – edge cases', () => {
  it('single tab: close returns that tab', () => {
    expect(closeTabSelection(['a.ts'], 'a.ts', 'close')).toEqual(['a.ts']);
  });
  it('single tab: right returns empty', () => {
    expect(closeTabSelection(['a.ts'], 'a.ts', 'right')).toEqual([]);
  });
  it('single tab: left returns empty', () => {
    expect(closeTabSelection(['a.ts'], 'a.ts', 'left')).toEqual([]);
  });
  it('two tabs: right from first returns second only', () => {
    expect(closeTabSelection(['a.ts', 'b.ts'], 'a.ts', 'right')).toEqual(['b.ts']);
  });
  it('two tabs: left from last returns first only', () => {
    expect(closeTabSelection(['a.ts', 'b.ts'], 'b.ts', 'left')).toEqual(['a.ts']);
  });
  it('preserves input order in output', () => {
    const result = closeTabSelection(paths, 'b.ts', 'right');
    expect(result).toEqual(['c.ts', 'd.ts', 'e.ts']);
  });
});

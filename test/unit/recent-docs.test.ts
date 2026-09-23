import { describe, expect, it } from 'vitest';
import {
  pushRecentDoc,
  RECENT_DOC_LIMIT,
  type RecentDoc,
  recentPaletteId,
  recentSubtitle,
} from '../../webview/recent-docs';

describe('recent-docs', () => {
  it('dedupes on kind, path and scope', () => {
    const staged: RecentDoc = { kind: 'diff', path: '/a', diffScope: 'staged' };
    const unstaged: RecentDoc = { kind: 'diff', path: '/a', diffScope: 'unstaged' };
    let list = pushRecentDoc([], staged);
    list = pushRecentDoc(list, unstaged);
    list = pushRecentDoc(list, staged);
    expect(list).toEqual([staged, unstaged]);
    list = pushRecentDoc(list, { kind: 'diff', path: '/a' });
    list = pushRecentDoc(list, { kind: 'file', path: '/a' });
    expect(list).toHaveLength(4);
  });

  it(`caps at ${RECENT_DOC_LIMIT}`, () => {
    let list: RecentDoc[] = [];
    for (let i = 0; i < RECENT_DOC_LIMIT + 3; i++)
      list = pushRecentDoc(list, { kind: 'file', path: `/f${i}` });
    expect(list).toHaveLength(RECENT_DOC_LIMIT);
    expect(list[0].path).toBe(`/f${RECENT_DOC_LIMIT + 2}`);
  });

  it('palette ids differ per scope', () => {
    expect(recentPaletteId({ kind: 'diff', path: '/a', diffScope: 'staged' })).toBe(
      'recent:diff:staged:/a',
    );
    expect(recentPaletteId({ kind: 'diff', path: '/a' })).toBe('recent:diff:all:/a');
  });

  it('subtitle', () => {
    expect(recentSubtitle({ kind: 'diff', path: '/a', diffScope: 'staged' })).toBe('diff (Index)');
    expect(recentSubtitle({ kind: 'diff', path: '/a', diffScope: 'unstaged' })).toBe(
      'diff (Working Tree)',
    );
    expect(recentSubtitle({ kind: 'diff', path: '/a' })).toBe('diff');
    expect(recentSubtitle({ kind: 'file', path: '/a' })).toBeUndefined();
  });
});

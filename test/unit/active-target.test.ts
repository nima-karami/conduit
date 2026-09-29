import { describe, expect, it } from 'vitest';
import { folderKey } from '../../src/folder-key';
import { activeTarget } from '../../webview/active-target';

const P = 'G:\\r\\a.txt';

describe('activeTarget', () => {
  it('file tab targets either side', () => {
    expect(activeTarget({ kind: 'file', path: P }, 'editor')).toEqual({
      path: P,
      key: folderKey(P),
      side: 'either',
    });
  });

  it('scoped diff targets its side', () => {
    expect(activeTarget({ kind: 'diff', path: P, diffScope: 'staged' }, 'editor')?.side).toBe(
      'staged',
    );
    expect(activeTarget({ kind: 'diff', path: P, diffScope: 'unstaged' }, 'editor')?.side).toBe(
      'unstaged',
    );
  });

  it('unscoped diff targets either', () => {
    expect(activeTarget({ kind: 'diff', path: '/r/a.txt' }, 'editor')).toEqual({
      path: '/r/a.txt',
      key: '/r/a.txt',
      side: 'either',
    });
  });

  it('commit-diff, review, web, git-history target nothing', () => {
    for (const kind of ['commit-diff', 'review', 'web', 'git-history'] as const) {
      expect(activeTarget({ kind, path: P }, 'editor')).toBeNull();
    }
  });

  it('null doc targets nothing', () => {
    expect(activeTarget(null, 'editor')).toBeNull();
  });

  it('non-editor center view targets nothing', () => {
    expect(activeTarget({ kind: 'file', path: P }, 'board')).toBeNull();
    expect(activeTarget({ kind: 'diff', path: P, diffScope: 'staged' }, 'canvas')).toBeNull();
  });
});

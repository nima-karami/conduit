import { describe, expect, it } from 'vitest';
import type { RepoHeadModel } from '../../src/changes-view-model';
import type { ChangeDTO } from '../../src/protocol';
import { type ActiveTarget, activeTarget } from '../../webview/active-target';
import { highlightedChange, highlightId } from '../../webview/change-highlight';

const change = (path: string, staged: boolean): ChangeDTO => ({
  path,
  added: 1,
  removed: 0,
  kind: 'M',
  staged,
});

function head(root: string, staged: string[], unstaged: string[]): RepoHeadModel {
  const s = staged.map((p) => change(p, true));
  const u = unstaged.map((p) => change(p, false));
  return {
    repo: { root, name: '.', folder: root, tag: 'home' },
    label: root,
    changes: [...s, ...u],
    staged: s,
    unstaged: u,
  };
}

const fileTarget = (path: string) => activeTarget({ kind: 'file', path }, 'editor');
const diffTarget = (path: string, diffScope: 'staged' | 'unstaged') =>
  activeTarget({ kind: 'diff', path, diffScope }, 'editor');

describe('highlightedChange', () => {
  it('MM file tab resolves to the unstaged row', () => {
    const heads = [head('G:/r', ['a.txt'], ['a.txt'])];
    expect(highlightedChange(heads, fileTarget('G:\\r\\a.txt'))).toEqual({
      root: 'G:/r',
      side: 'unstaged',
      path: 'a.txt',
    });
  });

  it('fully staged file tab falls back to staged', () => {
    const heads = [head('G:/r', ['a.txt'], ['b.txt'])];
    expect(highlightedChange(heads, fileTarget('G:\\r\\a.txt'))?.side).toBe('staged');
  });

  it('scoped diff tab highlights its own side of an MM file', () => {
    const heads = [head('G:/r', ['a.txt'], ['a.txt'])];
    expect(highlightedChange(heads, diffTarget('G:\\r\\a.txt', 'staged'))?.side).toBe('staged');
    expect(highlightedChange(heads, diffTarget('G:\\r\\a.txt', 'unstaged'))?.side).toBe('unstaged');
  });

  it('scoped staged diff with no staged row highlights nothing', () => {
    const heads = [head('G:/r', [], ['a.txt'])];
    expect(highlightedChange(heads, diffTarget('G:\\r\\a.txt', 'staged'))).toBeNull();
  });

  it('first head in order wins', () => {
    const t: ActiveTarget = { path: '/r/a.txt', key: '/r/a.txt', side: 'either' };
    const first = head('/r', [], ['a.txt']);
    const second = head('/r/', ['a.txt'], []);
    expect(highlightedChange([first, second], t)).toEqual({
      root: '/r',
      side: 'unstaged',
      path: 'a.txt',
    });
    expect(highlightedChange([second, first], t)).toEqual({
      root: '/r/',
      side: 'staged',
      path: 'a.txt',
    });
  });

  it('matches a nested relative path', () => {
    const heads = [head('G:/r', [], ['src/deep/x.ts'])];
    expect(highlightedChange(heads, fileTarget('G:\\r\\src\\deep\\x.ts'))?.path).toBe(
      'src/deep/x.ts',
    );
  });

  it('drive-letter spellings match', () => {
    const heads = [head('G:\\r', [], ['a.txt'])];
    for (const p of ['g:/r/a.txt', 'G:\\r\\a.txt', 'G:\\r/a.txt']) {
      expect(highlightedChange(heads, fileTarget(p))?.path).toBe('a.txt');
    }
  });

  it('POSIX paths are case-sensitive', () => {
    const heads = [head('/r', [], ['a.txt'])];
    expect(highlightedChange(heads, fileTarget('/R/a.txt'))).toBeNull();
    expect(highlightedChange(heads, fileTarget('/r/a.txt'))?.path).toBe('a.txt');
  });

  it('loading head matches nothing', () => {
    const loading: RepoHeadModel = { ...head('/r', [], []), changes: undefined };
    expect(highlightedChange([loading], fileTarget('/r/a.txt'))).toBeNull();
  });

  it('null target matches nothing', () => {
    expect(highlightedChange([head('/r', [], ['a.txt'])], null)).toBeNull();
  });
});

describe('highlightId', () => {
  it('is stable across equal inputs and null for null', () => {
    const a = highlightId({ root: 'G:\\r', side: 'staged', path: 'a.txt' });
    const b = highlightId({ root: 'g:/r/', side: 'staged', path: 'a.txt' });
    expect(a).toBe(b);
    expect(a).not.toBe(highlightId({ root: 'G:\\r', side: 'unstaged', path: 'a.txt' }));
    expect(highlightId(null)).toBeNull();
  });
});

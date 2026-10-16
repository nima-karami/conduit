import { describe, expect, it } from 'vitest';
import { folderKey } from '../../src/folder-key';
import { META_FILES, RepoPathMap, type RepoPaths } from '../../src/repo-path-map';

const repo = (root: string, gitDir: string, commonDir: string, branch?: string): RepoPaths => ({
  key: folderKey(root),
  root,
  gitDir: folderKey(gitDir),
  commonDir: folderKey(commonDir),
  ...(branch ? { branch } : {}),
});

const main = repo('/w/repoA', '/w/repoA/.git', '/w/repoA/.git', 'main');
const wt1 = repo('/t/ticket1/repoA', '/w/repoA/.git/worktrees/wt1', '/w/repoA/.git', 't1/repoA');
const wt2 = repo('/t/ticket2/repoA', '/w/repoA/.git/worktrees/wt2', '/w/repoA/.git', 't2/repoA');
// Nested inside repoA's tree and on a same-named branch, but with its own common dir.
const nested = repo(
  '/w/repoA/sub/repoB',
  '/w/repoA/sub/repoB/.git',
  '/w/repoA/sub/repoB/.git',
  't1/repoA',
);
const uninterrogated: RepoPaths = { key: folderKey('/w/repoC'), root: '/w/repoC' };

const map = new RepoPathMap([main, wt1, wt2, nested, uninterrogated]);
const at = (p: string) => map.classify(folderKey(p));

describe('RepoPathMap', () => {
  it('working-tree file maps to the deepest repo', () => {
    expect(at('/w/repoA/src/x.ts')).toEqual([{ key: main.key, kind: 'tree' }]);
    expect(at('/w/repoA/sub/repoB/y.ts')).toEqual([{ key: nested.key, kind: 'tree' }]);
    expect(at('/t/ticket1/repoA/a/b/c.ts')).toEqual([{ key: wt1.key, kind: 'tree' }]);
    expect(at('/w/repoC/z.ts')).toEqual([{ key: uninterrogated.key, kind: 'tree' }]);
  });

  it('a sibling whose name extends a repo root is not inside it', () => {
    expect(at('/w/repoAB/x.ts')).toEqual([]);
  });

  it('worktree index event maps to that worktree as tree', () => {
    expect(at('/w/repoA/.git/worktrees/wt1/index')).toEqual([{ key: wt1.key, kind: 'tree' }]);
  });

  it('worktree HEAD event maps to that worktree as meta', () => {
    expect(at('/w/repoA/.git/worktrees/wt1/HEAD')).toEqual([{ key: wt1.key, kind: 'meta' }]);
    expect(at('/w/repoA/.git/worktrees/wt2/rebase-merge/done')).toEqual([
      { key: wt2.key, kind: 'meta' },
    ]);
  });

  it('branch ref event maps to every worktree on that branch', () => {
    expect(at('/w/repoA/.git/refs/heads/t1/repoA')).toEqual([{ key: wt1.key, kind: 'meta' }]);
    expect(at('/w/repoA/.git/refs/heads/main')).toEqual([{ key: main.key, kind: 'meta' }]);
    expect(at('/w/repoA/.git/refs/heads/nobody')).toEqual([]);
    expect(map.isGitMetadata(folderKey('/w/repoA/.git/refs/heads/nobody'))).toBe(true);
  });

  it('packed-refs maps to every repo of the common dir', () => {
    const keys = at('/w/repoA/.git/packed-refs');
    expect(keys.every((h) => h.kind === 'meta')).toBe(true);
    expect(keys.map((h) => h.key).sort()).toEqual([main.key, wt1.key, wt2.key].sort());
  });

  it('objects and logs under .git map to nothing and are git metadata', () => {
    for (const p of [
      '/w/repoA/.git/objects/ab/cdef',
      '/w/repoA/.git/logs/HEAD',
      '/w/repoA/.git/worktrees/wt1/logs/HEAD',
      '/w/repoA/.git/worktrees/wt9/HEAD',
    ]) {
      expect(at(p)).toEqual([]);
      expect(map.isGitMetadata(folderKey(p))).toBe(true);
    }
  });

  it('loose file maps to nothing and is not git metadata', () => {
    expect(at('/w/notes.md')).toEqual([]);
    expect(map.isGitMetadata(folderKey('/w/notes.md'))).toBe(false);
    expect(map.isGitMetadata(folderKey('/w/repoA/src/x.ts'))).toBe(false);
  });

  it('main repo .git/HEAD is meta for the main worktree only', () => {
    expect(at('/w/repoA/.git/HEAD')).toEqual([{ key: main.key, kind: 'meta' }]);
    expect(at('/w/repoA/.git/index')).toEqual([{ key: main.key, kind: 'tree' }]);
  });

  it('drive-letter paths match whatever case the event arrives in', () => {
    const win = repo('C:/Code/App', 'C:/Code/App/.git', 'C:/Code/App/.git', 'Feature/X');
    const m = new RepoPathMap([win]);
    expect(m.classify(folderKey('c:\\Code\\App\\src\\a.ts'))).toEqual([
      { key: win.key, kind: 'tree' },
    ]);
    expect(m.classify(folderKey('C:\\Code\\App\\.git\\refs\\heads\\Feature\\X'))).toEqual([
      { key: win.key, kind: 'meta' },
    ]);
    expect(m.classify(folderKey('C:\\Code\\App\\.git\\HEAD'))).toEqual([
      { key: win.key, kind: 'meta' },
    ]);
    expect(m.classify(folderKey('C:\\Code\\App\\.git\\index'))).toEqual([
      { key: win.key, kind: 'tree' },
    ]);
  });

  it('names the operation markers and HEAD files', () => {
    for (const f of ['HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'])
      expect(META_FILES.has(f)).toBe(true);
    expect(META_FILES.has('rebase-merge') && META_FILES.has('rebase-apply')).toBe(true);
    expect(META_FILES.has('index')).toBe(false);
  });
});

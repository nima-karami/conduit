import { describe, expect, it } from 'vitest';
import { anyRepoDirty, dirtyFileCount, gitOf, repoGitFingerprint } from '../../src/repo-git';
import type { GitInfo } from '../../src/types';

const main: GitInfo = { kind: 'branch', branch: 'main', dirty: false };
const feat: GitInfo = { kind: 'branch', branch: 'feat', dirty: true, dirtyFiles: 3 };

describe('repo-git readers', () => {
  it('gitOf defaults to activeRepoRoot', () => {
    const s = { repoGit: { '/h': main, '/r/a': feat }, activeRepoRoot: '/r/a' };
    expect(gitOf(s)).toBe(feat);
    expect(gitOf(s, '/h')).toBe(main);
    expect(gitOf({ repoGit: s.repoGit, activeRepoRoot: undefined })).toBeUndefined();
    expect(gitOf({ repoGit: undefined, activeRepoRoot: '/h' })).toBeUndefined();
  });

  it('anyRepoDirty true when only an attached repo is dirty', () => {
    expect(anyRepoDirty({ repoGit: { '/h': main, '/r/a': feat } })).toBe(true);
    expect(anyRepoDirty({ repoGit: { '/h': main } })).toBe(false);
    expect(anyRepoDirty({ repoGit: undefined })).toBe(false);
  });

  it('dirtyFileCount sums, ignores none', () => {
    const other: GitInfo = { kind: 'detached', sha: 'abc1234', dirty: true, dirtyFiles: 2 };
    expect(
      dirtyFileCount({ repoGit: { '/h': main, '/a': feat, '/b': other, '/c': { kind: 'none' } } }),
    ).toBe(5);
    expect(dirtyFileCount({ repoGit: undefined })).toBe(0);
  });

  it('fingerprint of undefined is empty; differs on dirty and operation', () => {
    expect(repoGitFingerprint(undefined)).toBe('');
    expect(repoGitFingerprint(main)).not.toBe(repoGitFingerprint({ ...main, dirty: true }));
    expect(repoGitFingerprint(main)).not.toBe(repoGitFingerprint({ ...main, operation: 'rebase' }));
    expect(repoGitFingerprint(main)).toBe(repoGitFingerprint({ ...main }));
  });
});

import { describe, expect, it } from 'vitest';
import { anyRepoDirty, gitOf, repoGitFingerprint } from '../../src/repo-git';
import type { GitInfo } from '../../src/types';

const main: GitInfo = { kind: 'branch', branch: 'main', dirty: false };
const feat: GitInfo = { kind: 'branch', branch: 'feat', dirty: true };

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

  it('fingerprint of undefined is empty; differs on dirty and operation', () => {
    expect(repoGitFingerprint(undefined)).toBe('');
    expect(repoGitFingerprint(main)).not.toBe(repoGitFingerprint({ ...main, dirty: true }));
    expect(repoGitFingerprint(main)).not.toBe(repoGitFingerprint({ ...main, operation: 'rebase' }));
    expect(repoGitFingerprint(main)).toBe(repoGitFingerprint({ ...main }));
  });
});

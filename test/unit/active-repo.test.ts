import { describe, expect, it } from 'vitest';
import { repoForPath, resolveActiveRepo } from '../../src/active-repo';
import type { RepoInfo } from '../../src/repo-scan';

const repos: RepoInfo[] = [
  { root: '/work/A', name: '.', folder: '/work/A', tag: 'home' },
  { root: '/work/A/sub', name: 'sub', folder: '/work/A', tag: 'nested' },
  { root: '/work/B', name: '.', folder: '/work/B', tag: 'attached' },
];

describe('repoForPath', () => {
  it('returns the longest-prefix (segment-aware) repo containing the path', () => {
    expect(repoForPath(repos, '/work/A/sub/x.ts')).toBe('/work/A/sub');
    expect(repoForPath(repos, '/work/A/file.ts')).toBe('/work/A');
    expect(repoForPath(repos, '/work/B/y.ts')).toBe('/work/B');
  });
  it('does not match on a false (non-segment) prefix', () => {
    expect(repoForPath(repos, '/work/Bbb/y.ts')).toBeUndefined();
  });
  it('matches a repo root path itself', () => {
    expect(repoForPath(repos, '/work/B')).toBe('/work/B');
  });
  it('handles Windows backslashes', () => {
    expect(
      repoForPath(
        [{ root: 'C:/work/A', name: '.', folder: 'C:/work/A', tag: 'home' }],
        'C:\\work\\A\\x.ts',
      ),
    ).toBe('C:/work/A');
  });
});

describe('resolveActiveRepo', () => {
  const openedRoot = '/work/A';
  it('prefers a still-existing pinned root over everything', () => {
    expect(
      resolveActiveRepo({ repos, pinnedRoot: '/work/B', autoRoot: '/work/A', openedRoot }),
    ).toBe('/work/B');
  });
  it('ignores a pinned root that no longer exists and falls back to auto', () => {
    expect(
      resolveActiveRepo({ repos, pinnedRoot: '/work/GONE', autoRoot: '/work/B', openedRoot }),
    ).toBe('/work/B');
  });
  it('uses auto when no pin', () => {
    expect(resolveActiveRepo({ repos, autoRoot: '/work/A/sub', openedRoot })).toBe('/work/A/sub');
  });
  it('falls back to the opened-root repo when no pin/auto', () => {
    expect(resolveActiveRepo({ repos, openedRoot })).toBe('/work/A');
  });
  it('falls back to the first repo when opened root is not itself a repo', () => {
    const r: RepoInfo[] = [
      { root: '/work/X/r1', name: 'r1', folder: '/work/X', tag: 'nested' },
      { root: '/work/X/r2', name: 'r2', folder: '/work/X', tag: 'nested' },
    ];
    expect(resolveActiveRepo({ repos: r, openedRoot: '/work/X' })).toBe('/work/X/r1');
  });
  it('returns undefined when there are no repos', () => {
    expect(resolveActiveRepo({ repos: [], openedRoot })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { RepoInfo } from '../../src/repo-scan';
import {
  isIndexScope,
  retainSessionScopes,
  scopeChipFolders,
  searchRootAllowed,
  searchTargets,
} from '../../src/search-scope';

const repo = (root: string, tag: RepoInfo['tag'] = 'nested'): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder: root,
  tag,
});

describe('scopeChipFolders', () => {
  it('a non-git home with nested repos is a chip folder', () => {
    expect(
      scopeChipFolders({ home: '/w', roots: [], repos: [repo('/w/repoA'), repo('/w/repoB')] }),
    ).toEqual(['/w']);
  });

  it('a folder inside a repo is not a chip folder', () => {
    expect(
      scopeChipFolders({
        home: '/w/repoA/src',
        roots: ['/x/repoB', '/y'],
        repos: [repo('/w/repoA', 'home'), repo('/x/repoB', 'attached')],
      }),
    ).toEqual(['/y']);
  });

  it('a repo folder compares by folder key (separators, trailing slash)', () => {
    expect(
      scopeChipFolders({ home: 'C:\\w\\repoA\\', roots: [], repos: [repo('C:/w/repoA', 'home')] }),
    ).toEqual([]);
  });

  it('missing folders are left out', () => {
    expect(
      scopeChipFolders({
        home: '/w',
        roots: ['/y', '/z'],
        repos: [repo('/q/R')],
        homeMissing: true,
        missingRoots: ['/z'],
      }),
    ).toEqual(['/y']);
  });

  it('a session with no repo at all has no chip folder', () => {
    expect(scopeChipFolders({ home: '/w', roots: ['/y'], repos: [] })).toEqual([]);
  });

  it('one repo in an attached folder makes the non-git home a chip folder', () => {
    expect(
      scopeChipFolders({ home: '/w', roots: ['/x/repoB'], repos: [repo('/x/repoB', 'attached')] }),
    ).toEqual(['/w']);
  });

  it('before the first repo scan nothing is a chip folder', () => {
    expect(scopeChipFolders({ home: '/w', roots: [] })).toEqual([]);
  });
});

describe('searchTargets', () => {
  const folders = ['/w', '/x/repoB'];
  const chip = ['/w'];

  it('tracked searches every folder with the default index', () => {
    expect(searchTargets(folders, 'tracked', '/w/repoA', chip)).toEqual([
      { root: '/w', scope: 'tracked' },
      { root: '/x/repoB', scope: 'tracked' },
    ]);
  });

  it('repo scope targets only the active repo', () => {
    expect(searchTargets(folders, 'repo', '/w/repoA', chip)).toEqual([
      { root: '/w/repoA', scope: 'tracked' },
    ]);
  });

  it('everything marks only chip folders', () => {
    expect(searchTargets(folders, 'everything', '/w/repoA', chip)).toEqual([
      { root: '/w', scope: 'everything' },
      { root: '/x/repoB', scope: 'tracked' },
    ]);
  });

  it('everything matches chip folders by folder key', () => {
    expect(searchTargets(['C:\\w'], 'everything', undefined, ['C:/w/'])).toEqual([
      { root: 'C:\\w', scope: 'everything' },
    ]);
  });

  it('no active repo: repo scope yields no targets', () => {
    expect(searchTargets(folders, 'repo', undefined, chip)).toEqual([]);
  });
});

describe('IPC edge: isIndexScope / searchRootAllowed', () => {
  it('scope is absent or a known kind', () => {
    expect(isIndexScope(undefined)).toBe(true);
    expect(isIndexScope('tracked')).toBe(true);
    expect(isIndexScope('everything')).toBe(true);
    for (const bad of ['repo', 'Everything', '', null, 1, {}])
      expect(isIndexScope(bad)).toBe(false);
  });

  it("a root is one of the session's folders or registered repos, by folder key", () => {
    const s = { home: '/w', roots: ['/x'], repos: [repo('/w/tickets/T-1/repoA')] };
    expect(searchRootAllowed(s, '/w')).toBe(true);
    expect(searchRootAllowed(s, '/x/')).toBe(true);
    expect(searchRootAllowed(s, '/w/tickets/T-1/repoA')).toBe(true);
    expect(searchRootAllowed(s, '/w/tickets')).toBe(false);
    expect(searchRootAllowed(s, '/elsewhere')).toBe(false);
    expect(searchRootAllowed(s, '')).toBe(false);
    expect(searchRootAllowed(s, 42)).toBe(false);
    expect(searchRootAllowed({ home: '/w', roots: [] }, '/w/tickets/T-1/repoA')).toBe(false);
  });
});

describe('retainSessionScopes', () => {
  it('drops scopes of sessions that are gone; same object when none is', () => {
    const scopes = { a: 'everything', b: 'repo' } as const;
    expect(retainSessionScopes(scopes, new Set(['a', 'b', 'c']))).toBe(scopes);
    expect(retainSessionScopes(scopes, new Set(['b']))).toEqual({ b: 'repo' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildResolveRoots, rootsSigOf, userRootsOf } from '../../src/path-link-roots';
import type { RepoInfo } from '../../src/repo-scan';
import type { GitInfo } from '../../src/types';

const posix = { platform: 'posix' as const, caseSensitive: true };
const win = { platform: 'win32' as const, caseSensitive: false };

const repo = (root: string, tag: RepoInfo['tag'], folder: string): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder,
  tag,
});

interface Fields {
  home: string;
  roots: string[];
  repos?: RepoInfo[];
  missingRoots?: string[];
  repoGit?: Record<string, GitInfo>;
}
const session = (f: Partial<Fields> & { home: string }): Fields => ({ roots: [], ...f });

const parentOfMany = session({
  home: '/w',
  repos: [
    repo('/w/repoB', 'nested', '/w'),
    repo('/w/T-123/repoA-wt', 'nested', '/w'),
    repo('/w/repoA', 'nested', '/w'),
  ],
  repoGit: {
    '/w/T-123/repoA-wt': {
      kind: 'branch',
      branch: 'feat/x',
      isWorktree: true,
      worktreeName: 'repoA-wt',
    },
    '/w/repoA': { kind: 'branch', branch: 'main' },
  },
});

describe('buildResolveRoots', () => {
  it('parent of many: home, then nested and worktree by name', () => {
    const roots = buildResolveRoots(parentOfMany, '/w', posix);
    expect(roots.map((r) => [r.kind, r.name])).toEqual([
      ['home', 'w'],
      ['nested', 'repoA'],
      ['worktree', 'repoA-wt'],
      ['nested', 'repoB'],
    ]);
    const wt = roots.find((r) => r.kind === 'worktree');
    expect(wt).toMatchObject({ abs: '/w/T-123/repoA-wt', branch: 'feat/x', name: 'repoA-wt' });
    expect(roots.find((r) => r.name === 'repoA')?.branch).toBeUndefined();
  });

  it('cwd repo that is no root comes first as cwd-repo', () => {
    const roots = buildResolveRoots(session({ home: '/w' }), '/elsewhere/repo', posix);
    expect(roots.map((r) => [r.kind, r.abs])).toEqual([
      ['cwd-repo', '/elsewhere/repo'],
      ['home', '/w'],
    ]);
  });

  it('a cwd repo that is another root keeps that root kind and order', () => {
    const roots = buildResolveRoots(parentOfMany, '/w/repoA', posix);
    expect(roots.map((r) => r.kind)).toEqual(['home', 'nested', 'worktree', 'nested']);
  });

  it('home that is also RepoInfo tag home is one entry', () => {
    const s = session({ home: '/w/repoA', repos: [repo('/w/repoA', 'home', '/w/repoA')] });
    const roots = buildResolveRoots(s, '/w/repoA', posix);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ kind: 'home', abs: '/w/repoA', userChosen: true });
  });

  it('attached keep session.roots order', () => {
    const s = session({ home: '/h', roots: ['/z/second', '/a/first'] });
    expect(buildResolveRoots(s, '', posix).map((r) => [r.kind, r.abs])).toEqual([
      ['home', '/h'],
      ['attached', '/z/second'],
      ['attached', '/a/first'],
    ]);
  });

  it('missingRoots skipped', () => {
    const s = session({ home: '/h', roots: ['/a', '/b'], missingRoots: ['/a'] });
    expect(buildResolveRoots(s, '', posix).map((r) => r.abs)).toEqual(['/h', '/b']);
  });

  it('dedupes win32 folders by folder key', () => {
    const s = session({
      home: 'G:/W',
      repos: [repo('g:/w', 'home', 'G:/W'), repo('G:/W/RepoA', 'nested', 'G:/W')],
    });
    const roots = buildResolveRoots(s, 'g:/W/repoa', win);
    expect(roots.map((r) => r.kind)).toEqual(['home', 'nested']);
  });

  it('userChosen', () => {
    const s = session({
      home: '/w',
      roots: ['/att'],
      repos: [
        repo('/w/repoA', 'nested', '/w'),
        repo('/att/r', 'attached', '/att'),
        repo('/up', 'home', '/w'),
      ],
    });
    const byAbs = (cwdGitRoot: string) =>
      Object.fromEntries(buildResolveRoots(s, cwdGitRoot, posix).map((r) => [r.abs, r.userChosen]));
    expect(byAbs('/w/repoA')).toEqual({
      '/w': true,
      '/att': true,
      '/att/r': true,
      '/w/repoA': true,
      '/up': false,
    });
    expect(byAbs('/w/sub')['/w/sub']).toBe(true);
    expect(byAbs('/evil/share/repo')['/evil/share/repo']).toBe(false);
    expect(userRootsOf(s, posix)).toEqual(['/w', '/att', '/w/repoA', '/att/r']);
  });

  it('userRootsOf never includes the cwd or a repo outside the user roots', () => {
    const s = session({ home: '/w', repos: [repo('/up', 'home', '/w')] });
    expect(userRootsOf(s, posix)).toEqual(['/w']);
  });

  it('userRootsOf win32 folding', () => {
    const s = session({ home: 'g:/w', repos: [repo('G:/W/repoA', 'nested', 'g:/w')] });
    expect(userRootsOf(s, win)).toEqual(['g:/w', 'G:/W/repoA']);
    expect(userRootsOf(s, { platform: 'posix', caseSensitive: true })).toEqual([
      'g:/w',
      'G:/W/repoA',
    ]);
    const mac = session({
      home: '/Users/U/w',
      repos: [repo('/users/u/w/r', 'nested', '/Users/U/w')],
    });
    expect(userRootsOf(mac, { platform: 'posix', caseSensitive: false })).toEqual([
      '/Users/U/w',
      '/users/u/w/r',
    ]);
    expect(userRootsOf(mac, posix)).toEqual(['/Users/U/w']);
  });

  it('userRootsOf skips missing roots', () => {
    const s = session({
      home: '/w',
      roots: ['/a'],
      missingRoots: ['/a'],
      repos: [repo('/a/r', 'attached', '/a')],
    });
    expect(userRootsOf(s, posix)).toEqual(['/w']);
  });
});

describe('rootsSigOf', () => {
  const base = session({ home: '/w', roots: ['/a'], repos: [repo('/w/r', 'nested', '/w')] });
  const sig = rootsSigOf(base);

  it('is a stable 8-hex hash, identical for two sessions with the same fields', () => {
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
    expect(rootsSigOf(structuredClone(base))).toBe(sig);
  });

  it('changes on attach, detach, discovery and a root going missing', () => {
    expect(rootsSigOf({ ...base, roots: ['/a', '/b'] })).not.toBe(sig);
    expect(rootsSigOf({ ...base, roots: [] })).not.toBe(sig);
    expect(
      rootsSigOf({ ...base, repos: [...(base.repos ?? []), repo('/w/s', 'nested', '/w')] }),
    ).not.toBe(sig);
    expect(rootsSigOf({ ...base, missingRoots: ['/a'] })).not.toBe(sig);
    expect(rootsSigOf({ ...base, home: '/v' })).not.toBe(sig);
  });

  it('ignores repoGit and repos order', () => {
    expect(
      rootsSigOf({ ...base, repoGit: { '/w/r': { kind: 'branch', branch: 'x' } } } as Fields),
    ).toBe(sig);
    const two = { ...base, repos: [repo('/w/r', 'nested', '/w'), repo('/w/s', 'nested', '/w')] };
    expect(rootsSigOf({ ...two, repos: [...two.repos].reverse() })).toBe(rootsSigOf(two));
  });

  it('keeps attached order significant (it ranks)', () => {
    const ab = { ...base, roots: ['/a', '/b'] };
    expect(rootsSigOf({ ...base, roots: ['/b', '/a'] })).not.toBe(rootsSigOf(ab));
  });
});

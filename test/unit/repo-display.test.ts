import { describe, expect, it } from 'vitest';
import {
  historyRepoFor,
  orderRepos,
  repoBaseName,
  repoLabel,
  repoSetKey,
  repoSub,
} from '../../src/repo-display';
import type { RepoInfo, RepoTag } from '../../src/repo-scan';

const repo = (root: string, tag: RepoTag, folder: string): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder,
  tag,
});

describe('orderRepos', () => {
  it('home first, nested by root, attached by roots order then root', () => {
    const home = repo('/h', 'home', '/h');
    const nestedA = repo('/h/a', 'nested', '/h');
    const nestedZ = repo('/h/z', 'nested', '/h');
    const attA = repo('/r/a', 'attached', '/r/a');
    const attB1 = repo('/r/b/one', 'attached', '/r/b');
    const attB2 = repo('/r/b/two', 'attached', '/r/b');
    const input = [attB2, nestedZ, attA, home, nestedA, attB1];
    const out = orderRepos(input, ['/r/a', '/r/b']);
    expect(out.map((r) => r.root)).toEqual(['/h', '/h/a', '/h/z', '/r/a', '/r/b/one', '/r/b/two']);
    expect(input[0]).toBe(attB2);
  });

  it('attached folder matched by folderKey (C:/R/A vs c:/r/a)', () => {
    const first = repo('C:/R/A', 'attached', 'C:/R/A');
    const second = repo('/q', 'attached', '/q');
    const out = orderRepos([second, first], ['c:/r/a/', '/q']);
    expect(out.map((r) => r.root)).toEqual(['C:/R/A', '/q']);
  });

  it('an attached repo whose folder matches no root sorts last by root', () => {
    const lost = repo('/a-lost', 'attached', '/gone');
    const kept = repo('/z', 'attached', '/z');
    expect(orderRepos([lost, kept], ['/z']).map((r) => r.root)).toEqual(['/z', '/a-lost']);
  });
});

describe('repoSetKey', () => {
  it('repoSetKey ignores order and case-folds drive paths', () => {
    expect(repoSetKey([{ root: 'C:/x' }, { root: '/y' }])).toBe(
      repoSetKey([{ root: '/y' }, { root: 'c:/x/' }]),
    );
  });

  it('repoSetKey([]) === ""', () => {
    expect(repoSetKey([])).toBe('');
  });

  it('differs when the set differs', () => {
    expect(repoSetKey([{ root: '/a' }])).not.toBe(repoSetKey([{ root: '/a' }, { root: '/b' }]));
  });
});

describe('repoBaseName', () => {
  it('repoBaseName handles \\ and a trailing /', () => {
    expect(repoBaseName('C:\\work\\proj')).toBe('proj');
    expect(repoBaseName('/w/proj/')).toBe('proj');
    expect(repoBaseName('/w\\mixed/leaf\\')).toBe('leaf');
  });
});

describe('repoSub', () => {
  it('sub for a repo below its folder: room-message-bus/vendor/proto-schemas', () => {
    expect(
      repoSub({ root: '/w/room-message-bus/vendor/proto-schemas', folder: '/w/room-message-bus' }),
    ).toBe('room-message-bus/vendor/proto-schemas');
  });

  it('sub keeps the root spelling below a case-folded folder', () => {
    expect(repoSub({ root: 'C:/W/Bus/Vendor/X', folder: 'c:/w/bus/' })).toBe('bus/Vendor/X');
  });

  it('no sub when root is the folder (case-folded key)', () => {
    expect(repoSub({ root: 'C:/W/Proj', folder: 'c:/w/proj/' })).toBeUndefined();
  });

  it('no sub when root is not below its folder', () => {
    expect(repoSub({ root: '/w/busy', folder: '/w/bus' })).toBeUndefined();
  });
});

describe('repoLabel', () => {
  it('repoLabel: attached collision gets " — parent"; home/nested keep the bare name', () => {
    const home = repo('/w/app', 'home', '/w/app');
    const nested = repo('/w/app/vendor/app', 'nested', '/w/app');
    const attached = repo('/x/infra/app', 'attached', '/x/infra/app');
    const solo = repo('/x/tools', 'attached', '/x/tools');
    const all = [home, nested, attached, solo];
    expect(repoLabel(home, all)).toBe('app');
    expect(repoLabel(nested, all)).toBe('app');
    expect(repoLabel(attached, all)).toBe('app — infra');
    expect(repoLabel(solo, all)).toBe('tools');
  });

  it('an attached repo alone keeps the bare name', () => {
    const a = repo('C:/x/infra/app', 'attached', 'C:/x/infra/app');
    expect(repoLabel(a, [a])).toBe('app');
  });
});

describe('historyRepoFor', () => {
  const home = repo('C:/w/app', 'home', 'C:/w/app');
  const lib = repo('C:/w/app/lib', 'nested', 'C:/w/app');
  const att = repo('/x/att', 'attached', '/x/att');
  const s = { repos: [att, lib, home], roots: ['/x/att'], activeRepoRoot: 'C:/w/app/lib' };

  it('doc repo still detected → kept (key-folded)', () => {
    expect(historyRepoFor('c:/W/APP/', s)).toBe('C:/w/app');
    expect(historyRepoFor('/x/att', s)).toBe('/x/att');
  });

  it('doc repo gone → activeRepoRoot', () => {
    expect(historyRepoFor('/gone', s)).toBe('C:/w/app/lib');
    expect(historyRepoFor(undefined, s)).toBe('C:/w/app/lib');
  });

  it('no active → first in display order', () => {
    expect(historyRepoFor('/gone', { ...s, activeRepoRoot: undefined })).toBe('C:/w/app');
  });

  it('no repos → undefined', () => {
    expect(historyRepoFor('/x/att', { repos: [], roots: [] })).toBeUndefined();
    expect(historyRepoFor(undefined, { repos: undefined, roots: [] })).toBeUndefined();
    expect(historyRepoFor('/x/att', undefined)).toBeUndefined();
  });
});

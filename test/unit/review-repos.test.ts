import { describe, expect, it } from 'vitest';
import type { ChangeDTO, RepoChanges } from '../../src/protocol';
import type { RepoInfo, RepoTag } from '../../src/repo-scan';
import type { ReviewSource } from '../../webview/docs';
import {
  groupReviewFiles,
  isStaleWorkingRoot,
  type ReviewFile,
  repoChipLabel,
  repoChipRows,
  repoDisplayPath,
  resolveReviewRepo,
  reviewFileKey,
  reviewRepoChangesFor,
  reviewViewKey,
  tagReviewFiles,
  workingReviewFiles,
} from '../../webview/review-repos';

const change = (path: string, over: Partial<ChangeDTO> = {}): ChangeDTO => ({
  path,
  added: 1,
  removed: 0,
  kind: 'M',
  staged: false,
  ...over,
});

const repoChanges = (
  root: string,
  changes: ChangeDTO[],
  tag: RepoTag = 'home',
  over: Partial<RepoChanges> = {},
): RepoChanges => ({ root, name: root.split('/').pop() ?? root, tag, changes, ...over });

const info = (root: string, tag: RepoTag = 'home', folder = root): RepoInfo => ({
  root,
  name: '.',
  folder,
  tag,
});

const file = (repoRoot: string, path: string, over: Partial<ChangeDTO> = {}): ReviewFile => ({
  ...change(path, over),
  repoRoot,
});

const WORKING: ReviewSource = { kind: 'working' };
const TWO = [{ root: 'C:/w/rmb' }, { root: 'C:/w/proto' }];

describe('resolveReviewRepo', () => {
  it('working, no root, 2 repos → null', () => {
    expect(resolveReviewRepo(WORKING, TWO, 'C:/w/rmb')).toBeNull();
    expect(resolveReviewRepo(undefined, TWO, 'C:/w/rmb')).toBeNull();
  });

  it('working, no root, 1 repo → that root', () => {
    expect(resolveReviewRepo(WORKING, [{ root: 'C:/w/rmb' }], 'C:/other')).toBe('C:/w/rmb');
  });

  it('working, no root, 0 repos → fallbackRoot', () => {
    expect(resolveReviewRepo(WORKING, [], 'C:/w/fb')).toBe('C:/w/fb');
    expect(resolveReviewRepo(WORKING, [], undefined)).toBeNull();
  });

  it("working, root in set (C:/ vs c:\\) → the set's root bytes", () => {
    const source: ReviewSource = { kind: 'working', repoRoot: 'c:\\w\\proto' };
    expect(resolveReviewRepo(source, TWO, undefined)).toBe('C:/w/proto');
  });

  it('working, stale root → null with 2 repos, the single root with 1', () => {
    const source: ReviewSource = { kind: 'working', repoRoot: 'C:/w/gone' };
    expect(resolveReviewRepo(source, TWO, 'C:/w/rmb')).toBeNull();
    expect(resolveReviewRepo(source, [{ root: 'C:/w/rmb' }], 'C:/w/fb')).toBe('C:/w/rmb');
  });

  it('commit root outside the set → that root', () => {
    const source: ReviewSource = { kind: 'commit', sha: 'abc', repoRoot: 'D:/elsewhere' };
    expect(resolveReviewRepo(source, TWO, 'C:/w/rmb')).toBe('D:/elsewhere');
  });

  it('range without root → fallbackRoot', () => {
    const source: ReviewSource = {
      kind: 'range',
      base: { kind: 'branch', ref: 'main' },
      head: { kind: 'working' },
    };
    expect(resolveReviewRepo(source, TWO, 'C:/w/fb')).toBe('C:/w/fb');
    expect(resolveReviewRepo(source, TWO, undefined)).toBeNull();
  });
});

describe('isStaleWorkingRoot', () => {
  it('isStaleWorkingRoot only for an unmatched working root', () => {
    expect(isStaleWorkingRoot({ kind: 'working', repoRoot: 'C:/w/gone' }, TWO)).toBe(true);
    expect(isStaleWorkingRoot({ kind: 'working', repoRoot: 'c:\\w\\rmb' }, TWO)).toBe(false);
    expect(isStaleWorkingRoot({ kind: 'working' }, TWO)).toBe(false);
    expect(isStaleWorkingRoot(undefined, TWO)).toBe(false);
    expect(isStaleWorkingRoot({ kind: 'commit', sha: 'a', repoRoot: 'C:/w/gone' }, TWO)).toBe(
      false,
    );
  });
});

describe('reviewViewKey', () => {
  it('reviewViewKey differs per resolved root, sourceKey part unchanged', () => {
    const a = reviewViewKey('working', 'C:/w/rmb');
    const b = reviewViewKey('working', 'C:/w/proto');
    const all = reviewViewKey('working', null);
    expect(new Set([a, b, all]).size).toBe(3);
    for (const k of [a, b, all]) expect(k.split('\0')[0]).toBe('working');
    expect(all).toBe('working\0*');
  });
});

describe('workingReviewFiles', () => {
  const repos = [
    repoChanges('C:/w/rmb', [change('a.ts'), change('b.ts')]),
    repoChanges('C:/w/proto', [change('room.proto')], 'nested'),
  ];

  it('all repos in order', () => {
    expect(workingReviewFiles(repos, null).map((f) => [f.repoRoot, f.path])).toEqual([
      ['C:/w/rmb', 'a.ts'],
      ['C:/w/rmb', 'b.ts'],
      ['C:/w/proto', 'room.proto'],
    ]);
  });

  it('one repo by folderKey', () => {
    expect(workingReviewFiles(repos, 'c:\\w\\proto').map((f) => [f.repoRoot, f.path])).toEqual([
      ['C:/w/proto', 'room.proto'],
    ]);
  });

  it('unknown root → []', () => {
    expect(workingReviewFiles(repos, 'C:/w/gone')).toEqual([]);
  });

  it('drops .conduit/review-notes.json per repo, including an attached repo', () => {
    const withNotes = [
      repoChanges('C:/w/rmb', [change('.conduit/review-notes.json'), change('a.ts')]),
      repoChanges('D:/att', [change('.conduit/review-notes.json'), change('x.ts')], 'attached'),
    ];
    expect(workingReviewFiles(withNotes, null).map((f) => f.path)).toEqual(['a.ts', 'x.ts']);
  });

  it('same path in two repos → two files with distinct reviewFileKey', () => {
    const dup = [
      repoChanges('C:/w/rmb', [change('a.ts', { staged: true }), change('a.ts')]),
      repoChanges('C:/w/proto', [change('a.ts')]),
    ];
    const out = workingReviewFiles(dup, null);
    expect(out).toHaveLength(2);
    expect(out[0].staged).toBe(true);
    expect(out.map(reviewFileKey)).toEqual(['C:/w/rmb/a.ts', 'C:/w/proto/a.ts']);
  });
});

describe('tagReviewFiles', () => {
  it('tags with one root, dedupes, drops the notes artifact', () => {
    const out = tagReviewFiles(
      [{ path: 'a.ts' }, { path: 'a.ts' }, { path: '.conduit/review-notes.json' }, { path: 'b' }],
      'C:/w/rmb',
    );
    expect(out).toEqual([
      { path: 'a.ts', repoRoot: 'C:/w/rmb' },
      { path: 'b', repoRoot: 'C:/w/rmb' },
    ]);
  });
});

describe('groupReviewFiles', () => {
  const repos = [
    repoChanges('C:/w/rmb', [], 'home', { branch: 'main' }),
    repoChanges('C:/w/empty', [], 'nested'),
    repoChanges('C:/w/proto', [], 'nested', { sub: 'rmb/vendor/proto' }),
  ];
  const files = [
    file('C:/w/proto', 'room.proto'),
    file('C:/w/rmb', 'a.ts'),
    file('C:/w/rmb', 'b.ts'),
  ];

  it('repos order', () => {
    const groups = groupReviewFiles(files, repos, new Set());
    expect(groups.map((g) => g.root)).toEqual(['C:/w/rmb', 'C:/w/proto']);
    expect(groups[0]).toMatchObject({ name: 'rmb', tag: 'home', branch: 'main' });
    expect(groups[1]).toMatchObject({ tag: 'nested', sub: 'rmb/vendor/proto' });
    expect(groups[0].files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('empty group dropped', () => {
    const groups = groupReviewFiles(files, repos, new Set());
    expect(groups.some((g) => g.root === 'C:/w/empty')).toBe(false);
  });

  it('reviewed counted per group', () => {
    const groups = groupReviewFiles(
      files,
      repos,
      new Set(['C:/w/rmb/b.ts', 'C:/w/proto/room.proto', 'C:/w/proto/a.ts']),
    );
    expect(groups.map((g) => g.reviewed)).toEqual([1, 1]);
  });

  it('input already filtered → counts follow the filter', () => {
    const groups = groupReviewFiles(
      files.filter((f) => f.path !== 'b.ts'),
      repos,
      new Set(['C:/w/rmb/b.ts']),
    );
    expect(groups[0].files.map((f) => f.path)).toEqual(['a.ts']);
    expect(groups[0].reviewed).toBe(0);
  });
});

describe('reviewRepoChangesFor', () => {
  it('repos [] + fallback → one synthesized home entry holding changes', () => {
    const changes = [change('a.ts')];
    expect(reviewRepoChangesFor([], undefined, changes, 'C:/w/rmb')).toEqual([
      { root: 'C:/w/rmb', name: 'rmb', tag: 'home', changes },
    ]);
    expect(reviewRepoChangesFor(undefined, undefined, changes, 'C:/w/rmb')).toHaveLength(1);
    expect(reviewRepoChangesFor([], undefined, changes, undefined)).toEqual([]);
  });

  it('repos non-empty, repoChanges undefined → undefined', () => {
    expect(reviewRepoChangesFor([info('C:/w/rmb')], undefined, [], 'C:/w/rmb')).toBeUndefined();
    const rc = [repoChanges('C:/w/rmb', [change('a.ts')])];
    expect(reviewRepoChangesFor([info('C:/w/rmb')], rc, [], 'C:/w/rmb')).toEqual(rc);
  });
});

describe('repoChipRows', () => {
  const reviewRepos = [info('C:/w/rmb'), info('C:/w/proto', 'nested', 'C:/w/rmb')];

  it('All repos first and checked when null', () => {
    const rows = repoChipRows(reviewRepos, [], null, 'all');
    expect(rows[0]).toMatchObject({ root: null, label: 'All repos', checked: true });
    expect(rows.slice(1).map((r) => [r.root, r.label, r.checked])).toEqual([
      ['C:/w/rmb', 'rmb', false],
      ['C:/w/proto', 'proto', false],
    ]);
    const narrowed = repoChipRows(reviewRepos, [], 'c:\\w\\proto', 'all');
    expect(narrowed.map((r) => r.checked)).toEqual([false, false, true]);
  });

  it('hint "2 files" / "clean" / "…"', () => {
    const rc = [
      repoChanges('C:/w/rmb', [
        change('a.ts'),
        change('b.ts'),
        change('a.ts', { staged: true }),
        change('.conduit/review-notes.json'),
      ]),
      repoChanges('C:/w/proto', []),
    ];
    expect(repoChipRows(reviewRepos, rc, null, 'all').map((r) => r.hint)).toEqual([
      undefined,
      '2 files',
      'clean',
    ]);
    expect(repoChipRows(reviewRepos, undefined, null, 'all').map((r) => r.hint)).toEqual([
      undefined,
      '…',
      '…',
    ]);
  });

  it('scope staged counts staged only', () => {
    const rc = [
      repoChanges('C:/w/rmb', [change('a.ts', { staged: true }), change('a.ts'), change('b.ts')]),
      repoChanges('C:/w/proto', [change('p.ts')]),
    ];
    expect(repoChipRows(reviewRepos, rc, null, 'staged').map((r) => r.hint)).toEqual([
      undefined,
      '1 file',
      'clean',
    ]);
    expect(repoChipRows(reviewRepos, rc, null, 'unstaged').map((r) => r.hint)).toEqual([
      undefined,
      '2 files',
      '1 file',
    ]);
  });
});

describe('repoChipLabel / repoDisplayPath', () => {
  const reviewRepos = [info('C:/w/rmb'), info('D:/att/rmb', 'attached', 'D:/att')];

  it('repoChipLabel out-of-set root → basename', () => {
    expect(repoChipLabel(reviewRepos, null)).toBe('All repos');
    expect(repoChipLabel(reviewRepos, 'd:\\att\\rmb')).toBe('rmb — att');
    expect(repoChipLabel(reviewRepos, 'E:/far/away')).toBe('away');
  });

  it('display path is sub when present, else root', () => {
    expect(repoDisplayPath({ root: 'C:/w/proto', sub: 'rmb/vendor/proto' })).toBe(
      'rmb/vendor/proto',
    );
    expect(repoDisplayPath({ root: 'C:/w/proto' })).toBe('C:/w/proto');
  });
});

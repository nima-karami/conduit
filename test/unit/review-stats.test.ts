import { describe, expect, it } from 'vitest';
import type { ChangeDTO } from '../../src/protocol';
import type { ReviewFile } from '../../webview/review-repos';
import { computeDiffstat, computeReviewProgress } from '../../webview/review-stats';

const change = (over: Partial<ChangeDTO> = {}): ChangeDTO => ({
  path: 'a.ts',
  added: 0,
  removed: 0,
  kind: 'M',
  staged: false,
  ...over,
});

describe('computeDiffstat', () => {
  it('is 0/0/0 for an empty changeset', () => {
    expect(computeDiffstat([])).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it('sums added/removed across a mixed changeset', () => {
    const stat = computeDiffstat([
      change({ path: 'a.ts', added: 10, removed: 2 }),
      change({ path: 'b.ts', added: 3, removed: 7, kind: 'A' }),
      change({ path: 'c.ts', added: 0, removed: 5, kind: 'D' }),
    ]);
    expect(stat).toEqual({ files: 3, insertions: 13, deletions: 14 });
  });

  it('counts a binary/0-line file in files but not in lines', () => {
    const stat = computeDiffstat([
      change({ path: 'code.ts', added: 4, removed: 1 }),
      change({ path: 'logo.png', added: 0, removed: 0, kind: 'A' }),
    ]);
    expect(stat.files).toBe(2);
    expect(stat.insertions).toBe(4);
    expect(stat.deletions).toBe(1);
  });

  it('reports a single-file count (caller renders singular/plural off files)', () => {
    expect(computeDiffstat([change({ added: 1, removed: 0 })]).files).toBe(1);
    expect(computeDiffstat([change({ path: 'a' }), change({ path: 'b' })]).files).toBe(2);
  });
});

const rf = (path: string, repoRoot = '/r'): ReviewFile => ({ ...change({ path }), repoRoot });

describe('computeReviewProgress', () => {
  it('is 0/0 with a zero fraction for an empty changeset', () => {
    expect(computeReviewProgress([], new Set())).toEqual({ reviewed: 0, total: 0, fraction: 0 });
  });

  it('counts only the reviewed paths still in the changeset', () => {
    const files = [rf('a.ts'), rf('b.ts'), rf('c.ts')];
    expect(computeReviewProgress(files, new Set(['/r/a.ts', '/r/c.ts']))).toEqual({
      reviewed: 2,
      total: 3,
      fraction: 2 / 3,
    });
  });

  // The marks outlive a rescan, so a file that got committed away must not push the meter past
  // its own total ("4 / 3 reviewed").
  it('ignores reviewed paths that left the changeset', () => {
    const files = [rf('a.ts')];
    expect(
      computeReviewProgress(files, new Set(['/r/a.ts', '/r/gone.ts', '/r/also-gone.ts'])),
    ).toEqual({
      reviewed: 1,
      total: 1,
      fraction: 1,
    });
  });

  it('progress counts by reviewFileKey — same rel path in two repos counted once each', () => {
    const files = [rf('a.ts', 'C:/w/rmb'), rf('a.ts', 'C:/w/proto'), rf('b.ts', 'C:/w/proto')];
    expect(computeReviewProgress(files, new Set(['C:/w/rmb/a.ts']))).toEqual({
      reviewed: 1,
      total: 3,
      fraction: 1 / 3,
    });
    expect(computeReviewProgress(files, new Set(['C:/w/rmb/a.ts', 'C:/w/proto/a.ts']))).toEqual({
      reviewed: 2,
      total: 3,
      fraction: 2 / 3,
    });
    expect(computeReviewProgress(files, new Set(['a.ts']))).toMatchObject({ reviewed: 0 });
  });
});

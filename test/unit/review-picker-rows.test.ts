import { describe, expect, it } from 'vitest';
import type { RefEndpoint } from '../../src/git-range';
import {
  buildPinnedSources,
  isPinnedRowChecked,
  type PinnedSourceInput,
} from '../../webview/review-picker-rows';

const sha = (c: string) => c.repeat(40);
const at = (c: string): RefEndpoint => ({ kind: 'commit', sha: sha(c) });

const input = (over: Partial<PinnedSourceInput> = {}): PinnedSourceInput => ({
  head: { sha: sha('h'), subject: 'Fix the thing' },
  unpushed: { base: at('u'), head: at('h') },
  branchPoint: { base: at('b'), head: at('h') },
  ...over,
});

describe('buildPinnedSources', () => {
  it('offers all three rows, in order, when everything resolves', () => {
    expect(buildPinnedSources(input()).map((r) => r.id)).toEqual([
      'lastCommit',
      'unpushed',
      'branchPoint',
    ]);
  });

  it('maps Last commit onto the existing COMMIT source, subject included', () => {
    const [row] = buildPinnedSources(input());
    expect(row.source).toEqual({ kind: 'commit', sha: sha('h'), subject: 'Fix the thing' });
    expect(row.label).toBe('Last commit');
    expect(row.hint).toContain('hhhhhhh');
  });

  it('maps the two ranges onto the existing RANGE source with sha endpoints', () => {
    const rows = buildPinnedSources(input());
    expect(rows[1].source).toEqual({ kind: 'range', base: at('u'), head: at('h') });
    expect(rows[2].source).toEqual({ kind: 'range', base: at('b'), head: at('h') });
  });

  it('hides a row the host could not resolve', () => {
    expect(buildPinnedSources(input({ unpushed: null })).map((r) => r.id)).toEqual([
      'lastCommit',
      'branchPoint',
    ]);
    expect(buildPinnedSources(input({ branchPoint: null })).map((r) => r.id)).toEqual([
      'lastCommit',
      'unpushed',
    ]);
  });

  it('hides Last commit in a repo with no commits', () => {
    expect(buildPinnedSources(input({ head: null })).map((r) => r.id)).toEqual([
      'unpushed',
      'branchPoint',
    ]);
  });

  it('is empty when nothing resolves — the picker simply shows its usual rows', () => {
    expect(buildPinnedSources({ head: null, unpushed: null, branchPoint: null })).toEqual([]);
  });

  it('drops the subject when the commit has none, rather than printing "undefined"', () => {
    const [row] = buildPinnedSources(input({ head: { sha: sha('h'), subject: '' } }));
    expect(row.source).toEqual({ kind: 'commit', sha: sha('h') });
    expect(row.hint).toBe('hhhhhhh');
  });
});

describe('isPinnedRowChecked', () => {
  const [last, unpushed, branchPoint] = buildPinnedSources(input());

  it('checks Last commit when the current source is that commit', () => {
    expect(isPinnedRowChecked(last, { kind: 'commit', sha: sha('h') })).toBe(true);
    expect(isPinnedRowChecked(last, { kind: 'commit', sha: sha('x') })).toBe(false);
  });

  it('checks a range row by rangeKey, so the endpoints must match on both sides', () => {
    expect(isPinnedRowChecked(unpushed, { kind: 'range', base: at('u'), head: at('h') })).toBe(
      true,
    );
    expect(isPinnedRowChecked(unpushed, { kind: 'range', base: at('b'), head: at('h') })).toBe(
      false,
    );
    expect(isPinnedRowChecked(branchPoint, { kind: 'range', base: at('b'), head: at('h') })).toBe(
      true,
    );
  });

  it('checks nothing against the working tree or an absent source', () => {
    expect(isPinnedRowChecked(last, { kind: 'working' })).toBe(false);
    expect(isPinnedRowChecked(unpushed, undefined)).toBe(false);
  });
});

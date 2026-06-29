import { describe, expect, it } from 'vitest';
import { isCommitHex, parseBatchCheck } from '../../src/commit-token';

describe('isCommitHex — host re-assertion', () => {
  it('accepts lowercase hex 7–40 chars', () => {
    expect(isCommitHex('a1b2c3d')).toBe(true); // 7
    expect(isCommitHex('deadbeef')).toBe(true); // 8
    expect(isCommitHex('0'.repeat(40))).toBe(true); // 40 (full sha length)
  });

  it('rejects too-short / too-long / uppercase / non-hex / decorated', () => {
    expect(isCommitHex('abc123')).toBe(false); // 6, too short
    expect(isCommitHex(`${'a'.repeat(41)}`)).toBe(false); // 41, too long
    expect(isCommitHex('A1B2C3D')).toBe(false); // uppercase
    expect(isCommitHex('abc123g')).toBe(false); // non-hex g
    expect(isCommitHex('#abc1234')).toBe(false); // leading #
    expect(isCommitHex(' a1b2c3d')).toBe(false); // whitespace
  });
});

describe('parseBatchCheck — git cat-file --batch-check output', () => {
  const full = 'a'.repeat(40);
  const other = 'b'.repeat(40);

  it('resolves a commit line to its full oid', () => {
    const out = `${full} commit 213\n`;
    expect(parseBatchCheck(out, ['a1b2c3d'])).toEqual([{ token: 'a1b2c3d', commit: full }]);
  });

  it('returns null for missing / ambiguous / non-commit objects', () => {
    const out = ['deadbeef missing', 'cafe ambiguous', `${other} blob 12`, `${other} tree 40`].join(
      '\n',
    );
    expect(parseBatchCheck(out, ['deadbeef', 'cafe', 'blobtok', 'treetok'])).toEqual([
      { token: 'deadbeef', commit: null },
      { token: 'cafe', commit: null },
      { token: 'blobtok', commit: null },
      { token: 'treetok', commit: null },
    ]);
  });

  it('zips multiple results back to their input tokens in order', () => {
    const out = `${full} commit 100\nzzz missing\n${other} commit 200\n`;
    expect(parseBatchCheck(out, ['short1', 'short2', 'short3'])).toEqual([
      { token: 'short1', commit: full },
      { token: 'short2', commit: null },
      { token: 'short3', commit: other },
    ]);
  });

  it('handles empty stdout (not a repo) as all-null', () => {
    expect(parseBatchCheck('', ['x1234567', 'y1234567'])).toEqual([
      { token: 'x1234567', commit: null },
      { token: 'y1234567', commit: null },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { detectCommitTokens, filterCommitTokensByPathSpans } from '../../webview/terminal-links';

describe('detectCommitTokens — positives', () => {
  it('matches a standalone 7-char short sha', () => {
    const t = detectCommitTokens('a1b2c3d');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ raw: 'a1b2c3d', start: 0, end: 7 });
  });

  it('matches an 8-char short sha', () => {
    const t = detectCommitTokens('deadbeef');
    expect(t).toHaveLength(1);
    expect(t[0].raw).toBe('deadbeef');
  });

  it('matches a full 40-char sha', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const t = detectCommitTokens(sha);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ raw: sha, start: 0, end: 40 });
  });

  it('matches a hash after "Committed as " with correct span', () => {
    const line = 'Committed as a1b2c3d';
    const t = detectCommitTokens(line);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ raw: 'a1b2c3d', start: 13, end: 20 });
  });

  it('matches a hash at end of line with trailing sentence punctuation (not in span)', () => {
    for (const punct of ['.', ',', ')', ']']) {
      const t = detectCommitTokens(`see a1b2c3d${punct}`);
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ raw: 'a1b2c3d', start: 4, end: 11 });
    }
  });

  it('matches multiple hashes on one line', () => {
    const t = detectCommitTokens('a1b2c3d and e4f5a6b done');
    expect(t.map((x) => x.raw)).toEqual(['a1b2c3d', 'e4f5a6b']);
  });
});

describe('detectCommitTokens — negatives', () => {
  it('rejects a CSS color (#-prefixed)', () => {
    expect(detectCommitTokens('color: #a1b2c3d')).toHaveLength(0);
  });

  it('rejects a 0x hex literal', () => {
    expect(detectCommitTokens('0xdeadbeef')).toHaveLength(0);
  });

  it('rejects a 6-char run (too short)', () => {
    expect(detectCommitTokens('abc123')).toHaveLength(0);
  });

  it('rejects a 41-char run (too long)', () => {
    expect(detectCommitTokens('a'.repeat(41))).toHaveLength(0);
  });

  it('rejects uppercase hex', () => {
    expect(detectCommitTokens('A1B2C3D')).toHaveLength(0);
  });

  it('rejects a hex run glued inside a longer word/hash', () => {
    expect(detectCommitTokens('zabc1234')).toHaveLength(0); // preceded by word char
    expect(detectCommitTokens('abc1234xyz')).toHaveLength(0); // followed by word char
    expect(detectCommitTokens('g1234abc4')).toHaveLength(0); // leading non-hex word char
  });

  it('rejects a hex segment inside a path', () => {
    expect(detectCommitTokens('src/abc1234/x')).toHaveLength(0);
    expect(detectCommitTokens('/objects/ab/abc1234ef')).toHaveLength(0);
  });

  it('rejects a token with a trailing .ext', () => {
    expect(detectCommitTokens('abc1234.ts')).toHaveLength(0);
    expect(detectCommitTokens('abc1234.5')).toHaveLength(0); // decimal-ish
  });

  it('rejects an npm-integrity-style fragment (dash-glued)', () => {
    expect(detectCommitTokens('sha512-abc1234def')).toHaveLength(0); // preceded by -
    expect(detectCommitTokens('abc1234-def567')).toHaveLength(0); // followed by -
  });
});

describe('detectCommitTokens — per-row cap', () => {
  it('emits exactly 32 candidates for a line with more than 32 hex runs', () => {
    const line = Array.from({ length: 40 }, () => 'a1b2c3d').join(' ');
    expect(detectCommitTokens(line)).toHaveLength(32);
  });
});

describe('filterCommitTokensByPathSpans — path precedence (§3.4)', () => {
  it('drops a commit candidate overlapping a resolved path-link span', () => {
    const commits = detectCommitTokens('abc1234 def5678');
    // A resolved path link covering the first token's span.
    const kept = filterCommitTokensByPathSpans(commits, [{ start: 0, end: 7 }]);
    expect(kept.map((c) => c.raw)).toEqual(['def5678']);
  });

  it('keeps commit candidates that do not overlap any path span', () => {
    const commits = detectCommitTokens('abc1234 def5678');
    const kept = filterCommitTokensByPathSpans(commits, [{ start: 20, end: 30 }]);
    expect(kept.map((c) => c.raw)).toEqual(['abc1234', 'def5678']);
  });
});

import { describe, expect, it } from 'vitest';
import { parseBranchList } from '../../src/git-info';
import { decideSwitch, isKnownRef } from '../../src/git-switch';

/**
 * Pure unit tests for the branch-switcher gate + allow-list (Slice B). No git is spawned;
 * these cover the refuse-rule precedence and the host-side ref validation that keeps an
 * arbitrary renderer string out of `execFile`.
 */

describe('decideSwitch', () => {
  it('refuses when busy', () => {
    expect(decideSwitch({ busy: true, dirty: false })).toEqual({ ok: false, reason: 'busy' });
  });

  it('allows when idle and clean', () => {
    expect(decideSwitch({ busy: false, dirty: false })).toEqual({ ok: true });
  });

  it('refuses when idle but dirty', () => {
    expect(decideSwitch({ busy: false, dirty: true })).toEqual({ ok: false, reason: 'dirty' });
  });

  it('busy takes precedence over dirty (busy is the more dangerous condition)', () => {
    expect(decideSwitch({ busy: true, dirty: true })).toEqual({ ok: false, reason: 'busy' });
  });
});

describe('isKnownRef', () => {
  it('accepts a ref in the host-enumerated set', () => {
    expect(isKnownRef('feature', ['main', 'feature'])).toBe(true);
  });

  it('rejects a ref not in the set (no smuggled arg)', () => {
    expect(isKnownRef('--upload-pack=evil', ['main', 'feature'])).toBe(false);
    expect(isKnownRef('nope', ['main', 'feature'])).toBe(false);
  });

  it('rejects everything against an empty list', () => {
    expect(isKnownRef('main', [])).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isKnownRef('', ['main'])).toBe(false);
  });
});

describe('parseBranchList', () => {
  it('parses, de-dupes blanks, and locale-sorts for-each-ref output', () => {
    const stdout = 'main\nfeature\n\n  bugfix  \nfeature\n';
    expect(parseBranchList(stdout)).toEqual(['bugfix', 'feature', 'main']);
  });

  it('returns an empty list for empty output', () => {
    expect(parseBranchList('')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { IgnoreCache, isAuthoritative, namesSignature } from '../../src/ignore-cache';

describe('isAuthoritative', () => {
  it('accepts a real answer: a match list, nothing matched, or not a repo', () => {
    expect(isAuthoritative({ ok: true, code: 0 })).toBe(true);
    expect(isAuthoritative({ ok: false, code: 1 })).toBe(true);
    expect(isAuthoritative({ ok: false, code: 128 })).toBe(true);
  });

  it('rejects a timeout — the empty stdout that caused the un-dim flicker', () => {
    expect(isAuthoritative({ ok: false, code: null })).toBe(false);
  });

  it('rejects any other failure (missing binary, crash)', () => {
    expect(isAuthoritative({ ok: false, code: 127 })).toBe(false);
    expect(isAuthoritative({ ok: false, code: 2 })).toBe(false);
  });
});

describe('namesSignature', () => {
  it('is order-independent so a re-listing in another order still matches', () => {
    expect(namesSignature(['b', 'a'])).toBe(namesSignature(['a', 'b']));
  });

  it('distinguishes a changed listing', () => {
    expect(namesSignature(['a', 'b'])).not.toBe(namesSignature(['a', 'b', 'c']));
  });
});

describe('IgnoreCache', () => {
  const names = ['a', 'b'];

  it('serves an unchanged listing inside the TTL — collapsing a refresh burst', () => {
    const c = new IgnoreCache({ ttlMs: 500 });
    c.set('/d', names, new Set(['a']), 1000);
    expect(c.getFresh('/d', names, 1400)).toEqual(new Set(['a']));
  });

  it('expires at the TTL so a .gitignore edit is picked up without invalidation', () => {
    const c = new IgnoreCache({ ttlMs: 500 });
    c.set('/d', names, new Set(['a']), 1000);
    expect(c.getFresh('/d', names, 1500)).toBeUndefined();
  });

  it('re-checks when the listing changed, even within the TTL', () => {
    const c = new IgnoreCache({ ttlMs: 500 });
    c.set('/d', names, new Set(['a']), 1000);
    expect(c.getFresh('/d', ['a', 'b', 'c'], 1100)).toBeUndefined();
  });

  it('misses on an unknown directory', () => {
    expect(new IgnoreCache().getFresh('/nope', names, 0)).toBeUndefined();
  });

  it('getLast returns the last result at any age and regardless of listing', () => {
    const c = new IgnoreCache({ ttlMs: 500 });
    c.set('/d', names, new Set(['a']), 1000);
    // Well past the TTL and for a different listing — still the fallback for a failed call.
    expect(c.getLast('/d')).toEqual(new Set(['a']));
    expect(c.getLast('/other')).toBeUndefined();
  });

  it('keeps the newest write for a directory', () => {
    const c = new IgnoreCache();
    c.set('/d', names, new Set(['a']), 1000);
    c.set('/d', names, new Set(['b']), 2000);
    expect(c.getLast('/d')).toEqual(new Set(['b']));
    expect(c.size).toBe(1);
  });

  it('evicts oldest-written beyond the cap', () => {
    const c = new IgnoreCache({ max: 2 });
    c.set('/1', names, new Set(['a']), 1);
    c.set('/2', names, new Set(['b']), 2);
    c.set('/3', names, new Set(['c']), 3);
    expect(c.size).toBe(2);
    expect(c.getLast('/1')).toBeUndefined();
    expect(c.getLast('/3')).toEqual(new Set(['c']));
  });

  it('a re-write refreshes recency, so the other key evicts first', () => {
    const c = new IgnoreCache({ max: 2 });
    c.set('/1', names, new Set(['a']), 1);
    c.set('/2', names, new Set(['b']), 2);
    c.set('/1', names, new Set(['a']), 3);
    c.set('/3', names, new Set(['c']), 4);
    expect(c.getLast('/1')).toEqual(new Set(['a']));
    expect(c.getLast('/2')).toBeUndefined();
  });
});

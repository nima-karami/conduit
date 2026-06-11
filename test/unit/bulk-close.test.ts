import { describe, expect, it } from 'vitest';
import { closeAllIds, closeOthersIds } from '../../webview/bulk-close';

describe('closeAllIds', () => {
  it('returns every id in order', () => {
    expect(closeAllIds(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for no sessions', () => {
    expect(closeAllIds([])).toEqual([]);
  });

  it('returns the single id for one session', () => {
    expect(closeAllIds(['only'])).toEqual(['only']);
  });

  it('returns a copy, not the same reference', () => {
    const input = ['a', 'b'];
    const out = closeAllIds(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });
});

describe('closeOthersIds', () => {
  it('excludes the target, keeping the rest in order', () => {
    expect(closeOthersIds(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('returns nothing to close when the target is the only session', () => {
    expect(closeOthersIds(['only'], 'only')).toEqual([]);
  });

  it('returns nothing to close for an empty list', () => {
    expect(closeOthersIds([], 'x')).toEqual([]);
  });

  it('returns all ids when the target is not present', () => {
    expect(closeOthersIds(['a', 'b'], 'missing')).toEqual(['a', 'b']);
  });

  it('removes only the first match (ids are unique in practice)', () => {
    expect(closeOthersIds(['a', 'b', 'c'], 'a')).toEqual(['b', 'c']);
  });
});

import { describe, expect, it } from 'vitest';
import { moveBefore } from '../../src/reorder';

describe('moveBefore', () => {
  it('moves an item before a middle target', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves an item to the end when target is null', () => {
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });

  it('moves backward before an earlier target', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when dragId === targetId', () => {
    expect(moveBefore(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });

  it('appends when target is missing', () => {
    expect(moveBefore(['a', 'b'], 'a', 'zzz')).toEqual(['b', 'a']);
  });

  it('returns input when dragId absent', () => {
    const input = ['a', 'b'];
    expect(moveBefore(input, 'x', 'a')).toBe(input);
  });
});

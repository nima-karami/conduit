import { describe, expect, it } from 'vitest';
import { moveBefore, reorderByGroup } from '../../src/reorder';

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

describe('reorderByGroup', () => {
  // groupOf: first char of the id is its project key (e.g. 'a1' -> 'a')
  const g = (id: string) => id[0];

  it('moves a whole group before a later group, preserving order', () => {
    // groups [a, b, c]; move a before c -> [b, a, c]
    expect(reorderByGroup(['a1', 'a2', 'b1', 'c1', 'c2'], g, 'a', 'c')).toEqual([
      'b1',
      'a1',
      'a2',
      'c1',
      'c2',
    ]);
  });

  it('moves a group to the end when target is null', () => {
    expect(reorderByGroup(['a1', 'b1', 'b2', 'c1'], g, 'a', null)).toEqual([
      'b1',
      'b2',
      'c1',
      'a1',
    ]);
  });

  it('moves a later group before an earlier group', () => {
    // groups [a, b, c]; move c before a -> [c, a, b]
    expect(reorderByGroup(['a1', 'b1', 'c1', 'c2'], g, 'c', 'a')).toEqual(['c1', 'c2', 'a1', 'b1']);
  });

  it('preserves each group internal order', () => {
    const out = reorderByGroup(['a1', 'a2', 'a3', 'b1'], g, 'a', null);
    // a-group ids keep relative order a1,a2,a3 wherever they land
    expect(out.filter((id) => id[0] === 'a')).toEqual(['a1', 'a2', 'a3']);
  });

  it('is a no-op when dragGroup === targetGroup (same ref)', () => {
    const input = ['a1', 'a2', 'b1'];
    expect(reorderByGroup(input, g, 'a', 'a')).toBe(input);
  });

  it('is a no-op when dragGroup has no ids (same ref)', () => {
    const input = ['a1', 'b1'];
    expect(reorderByGroup(input, g, 'z', 'a')).toBe(input);
  });

  it('appends the group when targetGroup is absent', () => {
    expect(reorderByGroup(['a1', 'b1'], g, 'a', 'zzz')).toEqual(['b1', 'a1']);
  });
});

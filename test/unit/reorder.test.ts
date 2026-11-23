import { describe, expect, it } from 'vitest';
import { insertionEdge, insertionIndex, isUnchangedInsertion, moveBefore } from '../../src/reorder';

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

describe('insertionIndex', () => {
  const items = [
    { left: 10, right: 30, top: 100, bottom: 140 },
    { left: 30, right: 60, top: 140, bottom: 200 },
    { left: 60, right: 80, top: 200, bottom: 240 },
  ];

  it.each([
    ['horizontal', { x: 10, y: 240 }, 0],
    ['horizontal', { x: 20, y: 100 }, 1],
    ['horizontal', { x: 44, y: 100 }, 1],
    ['horizontal', { x: 46, y: 100 }, 2],
    ['horizontal', { x: 75, y: 100 }, 3],
    ['horizontal', { x: 90, y: 100 }, 3],
    ['vertical', { x: 80, y: 100 }, 0],
    ['vertical', { x: 10, y: 150 }, 1],
    ['vertical', { x: 10, y: 180 }, 2],
    ['vertical', { x: 10, y: 225 }, 3],
    ['vertical', { x: 10, y: 250 }, 3],
  ] as const)('resolves a %s pointer at %j to slot %i', (axis, pointer, slot) => {
    expect(insertionIndex(items, pointer, axis)).toBe(slot);
  });

  it('returns slot zero for an empty list', () => {
    expect(insertionIndex([], { x: 500, y: 500 }, 'horizontal')).toBe(0);
  });

  it('leaves the order unchanged in either half of the dragged item', () => {
    for (const x of [35, 55]) {
      expect(isUnchangedInsertion(1, insertionIndex(items, { x, y: 0 }, 'horizontal'))).toBe(true);
    }
    expect(isUnchangedInsertion(1, 0)).toBe(false);
    expect(isUnchangedInsertion(-1, 0)).toBe(false);
  });

  it('marks the leading edge of the next item, or the trailing edge at the end', () => {
    expect(insertionEdge(0, 0, 3)).toBe('before');
    expect(insertionEdge(1, 1, 3)).toBe('before');
    expect(insertionEdge(1, 0, 3)).toBeUndefined();
    expect(insertionEdge(3, 2, 3)).toBe('after');
    expect(insertionEdge(null, 2, 3)).toBeUndefined();
  });
});

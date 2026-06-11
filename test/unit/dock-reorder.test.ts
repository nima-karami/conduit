import { describe, expect, it } from 'vitest';
import { reorderDock } from '../../webview/dock-reorder';

// The dock layout is an ordered permutation of three regions, but reorderDock is
// generic over id lists, so we exercise it on both the real region order and on
// small abstract lists to pin down direction symmetry exhaustively.

describe('reorderDock — direction symmetry (the bug)', () => {
  const def = ['sessions', 'center', 'explorer'] as const;

  it('drags the LEFT panel onto the RIGHT panel -> lands to the right of it (was broken)', () => {
    // sessions (idx 0) dropped on explorer (idx 2): dragging right -> after explorer.
    expect(reorderDock([...def], 'sessions', 'explorer')).toEqual([
      'center',
      'explorer',
      'sessions',
    ]);
  });

  it('drags the RIGHT panel onto the LEFT panel -> lands to the left of it (already worked)', () => {
    // explorer (idx 2) dropped on sessions (idx 0): dragging left -> before sessions.
    expect(reorderDock([...def], 'explorer', 'sessions')).toEqual([
      'explorer',
      'sessions',
      'center',
    ]);
  });

  it('is reversible: dragging back the other way undoes the move', () => {
    const swapped = reorderDock([...def], 'sessions', 'explorer'); // [center, explorer, sessions]
    expect(swapped).toEqual(['center', 'explorer', 'sessions']);
    // sessions now sits right of explorer; dragging it (left) back onto center
    // restores it ahead of center -> [sessions, center, explorer] = the default.
    expect(reorderDock(swapped, 'sessions', 'center')).toEqual([...def]);
  });
});

describe('reorderDock — adjacent swaps', () => {
  it('adjacent left->right (source left of target) places after target', () => {
    expect(reorderDock(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c']);
  });

  it('adjacent right->left (source right of target) places before target', () => {
    expect(reorderDock(['a', 'b', 'c'], 'b', 'a')).toEqual(['b', 'a', 'c']);
  });

  it('adjacent swap is the same result regardless of which neighbor is dragged', () => {
    // dragging a onto b and dragging b onto a both yield the swap [b, a, c]
    expect(reorderDock(['a', 'b', 'c'], 'a', 'b')).toEqual(reorderDock(['a', 'b', 'c'], 'b', 'a'));
  });
});

describe('reorderDock — ends and multi-panel moves', () => {
  it('moves the first item to just after the last (rightward across all)', () => {
    expect(reorderDock(['a', 'b', 'c', 'd'], 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves the last item to just before the first (leftward across all)', () => {
    expect(reorderDock(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves rightward onto a middle target -> after it', () => {
    expect(reorderDock(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves leftward onto a middle target -> before it', () => {
    expect(reorderDock(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
});

describe('reorderDock — no-ops (same reference, so callers can skip persisting)', () => {
  it('drop on self is a no-op and returns the same array', () => {
    const input = ['a', 'b', 'c'];
    expect(reorderDock(input, 'b', 'b')).toBe(input);
  });

  it('returns the same array when the source id is absent', () => {
    const input = ['a', 'b'];
    expect(reorderDock(input, 'z', 'a')).toBe(input);
  });

  it('returns the same array when the target id is absent', () => {
    const input = ['a', 'b'];
    expect(reorderDock(input, 'a', 'z')).toBe(input);
  });
});

describe('reorderDock — 2-panel config', () => {
  it('swaps the two regardless of direction', () => {
    expect(reorderDock(['a', 'b'], 'a', 'b')).toEqual(['b', 'a']);
    expect(reorderDock(['a', 'b'], 'b', 'a')).toEqual(['b', 'a']);
  });
});

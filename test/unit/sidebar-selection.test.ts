import { describe, expect, it } from 'vitest';
import {
  applyRowClick,
  descendantIds,
  NO_SELECTION,
  pruneSelection,
  selectPlain,
} from '../../webview/sidebar-selection';

const VISIBLE = ['a', 'b', 'c', 'd', 'e'];
const CTRL = { ctrl: true, shift: false };
const SHIFT = { ctrl: false, shift: true };
const PLAIN = { ctrl: false, shift: false };

describe('applyRowClick', () => {
  it('a plain click selects only that row and anchors on it', () => {
    const sel = applyRowClick(NO_SELECTION, 'b', PLAIN, VISIBLE);
    expect(sel).toEqual({ ids: ['b'], anchor: 'b' });
  });

  it('a plain click replaces an existing multi-selection', () => {
    const multi = { ids: ['a', 'c'], anchor: 'c' };
    expect(applyRowClick(multi, 'e', PLAIN, VISIBLE)).toEqual({ ids: ['e'], anchor: 'e' });
  });

  it('ctrl+click adds an unselected row and moves the anchor to it', () => {
    const one = selectPlain('a');
    expect(applyRowClick(one, 'c', CTRL, VISIBLE)).toEqual({ ids: ['a', 'c'], anchor: 'c' });
  });

  it('ctrl+click removes an already selected row', () => {
    const two = { ids: ['a', 'c'], anchor: 'c' };
    expect(applyRowClick(two, 'a', CTRL, VISIBLE)).toEqual({ ids: ['c'], anchor: 'a' });
  });

  it('shift+click selects the visible range from the anchor, in visible order', () => {
    const anchored = selectPlain('d');
    expect(applyRowClick(anchored, 'b', SHIFT, VISIBLE)).toEqual({
      ids: ['b', 'c', 'd'],
      anchor: 'd',
    });
  });

  it('shift+click reaches forward from the anchor too', () => {
    const anchored = selectPlain('b');
    expect(applyRowClick(anchored, 'd', SHIFT, VISIBLE)).toEqual({
      ids: ['b', 'c', 'd'],
      anchor: 'b',
    });
  });

  it('shift+click after a ctrl+click ranges from the ctrl-clicked row', () => {
    const picked = applyRowClick(selectPlain('a'), 'c', CTRL, VISIBLE);
    expect(applyRowClick(picked, 'e', SHIFT, VISIBLE).ids).toEqual(['c', 'd', 'e']);
  });

  it('shift+click with no usable anchor selects just the clicked row', () => {
    expect(applyRowClick(NO_SELECTION, 'c', SHIFT, VISIBLE)).toEqual({ ids: ['c'], anchor: 'c' });
  });

  it('shift+click ignores an anchor that is no longer visible (folded away)', () => {
    const hidden = { ids: ['z'], anchor: 'z' };
    expect(applyRowClick(hidden, 'c', SHIFT, VISIBLE)).toEqual({ ids: ['c'], anchor: 'c' });
  });
});

describe('pruneSelection', () => {
  it('drops sessions that no longer exist and keeps the rest', () => {
    const sel = { ids: ['a', 'b', 'c'], anchor: 'b' };
    expect(pruneSelection(sel, new Set(['a', 'c']))).toEqual({ ids: ['a', 'c'], anchor: null });
  });

  it('returns the same object when nothing was removed', () => {
    const sel = { ids: ['a'], anchor: 'a' };
    expect(pruneSelection(sel, new Set(['a', 'x']))).toBe(sel);
  });

  it('clears to the empty selection when every selected session is gone', () => {
    expect(pruneSelection({ ids: ['a'], anchor: 'a' }, new Set())).toEqual(NO_SELECTION);
  });
});

describe('descendantIds', () => {
  const children: Record<string, string[]> = {
    lead: ['c1', 'c2'],
    c1: ['g1'],
    c2: [],
    g1: [],
  };
  const childrenOf = (id: string) => children[id] ?? [];

  it('lists every descendant, not the node itself', () => {
    expect(descendantIds(childrenOf, 'lead')).toEqual(['c1', 'g1', 'c2']);
  });

  it('is empty for a leaf', () => {
    expect(descendantIds(childrenOf, 'c2')).toEqual([]);
  });
});

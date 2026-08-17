import { describe, expect, it } from 'vitest';
import { nextVisiblePath } from '../../webview/file-tree';
import {
  activePath,
  clearSelection,
  EMPTY_SELECTION,
  reconcile,
  type SelectionState,
  selectAll,
  selectOne,
  selectRange,
  toggle,
} from '../../webview/file-tree-selection';

// Background mirrors the spec's Gherkin: a.ts, b.ts, c.ts, d.ts in visible order.
const ORDER = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
const set = (s: SelectionState) => [...s.selected].sort();

describe('EMPTY_SELECTION', () => {
  it('is an empty set with no anchor', () => {
    expect(set(EMPTY_SELECTION)).toEqual([]);
    expect(EMPTY_SELECTION.anchor).toBeNull();
  });
});

describe('selectOne', () => {
  it('selects exactly one row and seats the anchor there', () => {
    const s = selectOne('a.ts');
    expect(set(s)).toEqual(['a.ts']);
    expect(s.anchor).toBe('a.ts');
  });

  it('replaces a prior multi-selection (plain click collapses and reseats anchor)', () => {
    const multi: SelectionState = { selected: new Set(['a.ts', 'b.ts', 'c.ts']), anchor: 'a.ts' };
    const s = selectOne('d.ts');
    expect(set(s)).toEqual(['d.ts']);
    expect(s.anchor).toBe('d.ts');
    // input untouched
    expect(set(multi)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('toggle', () => {
  it('adds an unselected row and moves the anchor (additive + independent)', () => {
    const s = toggle(selectOne('a.ts'), 'c.ts');
    expect(set(s)).toEqual(['a.ts', 'c.ts']);
    expect(s.anchor).toBe('c.ts');
  });

  it('removes a selected row, leaving the rest', () => {
    const s = toggle({ selected: new Set(['a.ts', 'c.ts']), anchor: 'c.ts' }, 'c.ts');
    expect(set(s)).toEqual(['a.ts']);
    expect(s.anchor).toBe('c.ts');
  });

  it('toggling the last selected row off empties the set but keeps the anchor (VS Code parity)', () => {
    const s = toggle(selectOne('a.ts'), 'a.ts');
    expect(set(s)).toEqual([]);
    expect(s.anchor).toBe('a.ts');
  });

  it('does not mutate the input set', () => {
    const before = selectOne('a.ts');
    toggle(before, 'b.ts');
    expect(set(before)).toEqual(['a.ts']);
  });
});

describe('selectRange', () => {
  it('selects the inclusive contiguous run from the anchor, leaving the anchor fixed', () => {
    const s = selectRange(selectOne('a.ts'), 'c.ts', ORDER);
    expect(set(s)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(s.anchor).toBe('a.ts');
  });

  it('re-ranges from the same fixed anchor on a follow-up shift-click', () => {
    const first = selectRange(selectOne('a.ts'), 'c.ts', ORDER);
    const second = selectRange(first, 'd.ts', ORDER);
    expect(set(second)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(second.anchor).toBe('a.ts');
  });

  it('works when the clicked row is above the anchor', () => {
    const s = selectRange(selectOne('d.ts'), 'b.ts', ORDER);
    expect(set(s)).toEqual(['b.ts', 'c.ts', 'd.ts']);
    expect(s.anchor).toBe('d.ts');
  });

  it('shift-clicking the anchor itself yields just the anchor', () => {
    const s = selectRange(selectOne('b.ts'), 'b.ts', ORDER);
    expect(set(s)).toEqual(['b.ts']);
    expect(s.anchor).toBe('b.ts');
  });

  it('falls back to a plain select when the anchor is null', () => {
    const s = selectRange(EMPTY_SELECTION, 'c.ts', ORDER);
    expect(set(s)).toEqual(['c.ts']);
    expect(s.anchor).toBe('c.ts');
  });

  it('falls back to a plain select when the anchor is no longer visible', () => {
    const stale: SelectionState = { selected: new Set(['gone.ts']), anchor: 'gone.ts' };
    const s = selectRange(stale, 'c.ts', ORDER);
    expect(set(s)).toEqual(['c.ts']);
    expect(s.anchor).toBe('c.ts');
  });
});

describe('clearSelection', () => {
  it('returns an empty selection with no anchor', () => {
    const s = clearSelection();
    expect(set(s)).toEqual([]);
    expect(s.anchor).toBeNull();
  });
});

describe('reconcile', () => {
  it('prunes selected paths that left the visible order', () => {
    const s = reconcile({ selected: new Set(['a.ts', 'x.ts']), anchor: 'a.ts' }, ORDER);
    expect(set(s)).toEqual(['a.ts']);
    expect(s.anchor).toBe('a.ts');
  });

  it('clears the anchor when the anchor path vanished', () => {
    const s = reconcile({ selected: new Set(['a.ts']), anchor: 'gone.ts' }, ORDER);
    expect(set(s)).toEqual(['a.ts']);
    expect(s.anchor).toBeNull();
  });

  it('drops hidden descendants when a folder collapses', () => {
    // Given {src/, src/x.ts}; collapsing src/ removes src/x.ts from the visible order.
    const s = reconcile({ selected: new Set(['src/', 'src/x.ts']), anchor: 'src/x.ts' }, [
      'src/',
      'other.ts',
    ]);
    expect(set(s)).toEqual(['src/']);
    expect(s.anchor).toBeNull();
  });

  it('returns the same reference when nothing changed (state-update bail-out)', () => {
    const before: SelectionState = { selected: new Set(['a.ts', 'b.ts']), anchor: 'a.ts' };
    expect(reconcile(before, ORDER)).toBe(before);
  });

  it('keeps an anchor that is still visible even when it is not selected (toggled-off row)', () => {
    const s = reconcile({ selected: new Set(['a.ts']), anchor: 'b.ts' }, ORDER);
    expect(set(s)).toEqual(['a.ts']);
    expect(s.anchor).toBe('b.ts');
  });
});

describe('activePath', () => {
  it('returns the anchor', () => {
    expect(activePath(selectOne('a.ts'))).toBe('a.ts');
    expect(activePath(EMPTY_SELECTION)).toBeNull();
  });
});

describe('selectAll', () => {
  it('selects every visible row', () => {
    expect(set(selectAll(EMPTY_SELECTION, ORDER))).toEqual(ORDER);
  });

  it('keeps an anchor that is still visible', () => {
    const s = selectAll(selectOne('c.ts'), ORDER);
    expect(set(s)).toEqual(ORDER);
    expect(s.anchor).toBe('c.ts');
  });

  it('seats the anchor at the first visible row when there is none', () => {
    expect(selectAll(EMPTY_SELECTION, ORDER).anchor).toBe('a.ts');
  });

  it('seats the anchor at the first visible row when the old anchor vanished', () => {
    const stale: SelectionState = { selected: new Set(['gone.ts']), anchor: 'gone.ts' };
    const s = selectAll(stale, ORDER);
    expect(set(s)).toEqual(ORDER);
    expect(s.anchor).toBe('a.ts');
  });

  it('clears the selection when nothing is visible', () => {
    const s = selectAll(selectOne('a.ts'), []);
    expect(set(s)).toEqual([]);
    expect(s.anchor).toBeNull();
  });

  it('is idempotent', () => {
    const once = selectAll(selectOne('b.ts'), ORDER);
    const twice = selectAll(once, ORDER);
    expect(set(twice)).toEqual(ORDER);
    expect(twice.anchor).toBe('b.ts');
  });

  it('does not mutate the input', () => {
    const before = selectOne('a.ts');
    selectAll(before, ORDER);
    expect(set(before)).toEqual(['a.ts']);
  });
});

// The keyboard gestures compose the existing model with nextVisiblePath exactly as the tree's
// key handler does; these pin the composition (the range/anchor semantics), not the handler.
// See docs/specs/2026-08-17-explorer-keyboard-multiselect.md §2.
describe('keyboard range gestures', () => {
  const shiftArrow = (s: SelectionState, focus: string, dir: 'up' | 'down' | 'first' | 'last') => {
    const next = nextVisiblePath(ORDER, focus, dir);
    if (!next) throw new Error('no next row');
    return { state: selectRange(s, next, ORDER), focus: next };
  };

  it('grows from a fixed anchor on repeated Shift+ArrowDown', () => {
    let cur = { state: selectOne('a.ts'), focus: 'a.ts' };
    cur = shiftArrow(cur.state, cur.focus, 'down');
    expect(set(cur.state)).toEqual(['a.ts', 'b.ts']);
    cur = shiftArrow(cur.state, cur.focus, 'down');
    expect(set(cur.state)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(cur.state.anchor).toBe('a.ts');
    expect(cur.focus).toBe('c.ts');
  });

  it('SHRINKS rather than inverts when the direction reverses', () => {
    let cur = { state: selectOne('a.ts'), focus: 'a.ts' };
    cur = shiftArrow(cur.state, cur.focus, 'down');
    cur = shiftArrow(cur.state, cur.focus, 'down');
    expect(set(cur.state)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    cur = shiftArrow(cur.state, cur.focus, 'up');
    expect(set(cur.state)).toEqual(['a.ts', 'b.ts']);
    expect(cur.state.anchor).toBe('a.ts');
    expect(cur.focus).toBe('b.ts');
  });

  it('crosses the anchor and re-ranges on the other side', () => {
    let cur = { state: selectOne('c.ts'), focus: 'c.ts' };
    cur = shiftArrow(cur.state, cur.focus, 'up');
    expect(set(cur.state)).toEqual(['b.ts', 'c.ts']);
    cur = shiftArrow(cur.state, cur.focus, 'up');
    expect(set(cur.state)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(cur.state.anchor).toBe('c.ts');
  });

  it('Shift+End ranges to the last row and Shift+Home back to the first, anchor fixed', () => {
    const anchored = selectOne('b.ts');
    const toEnd = shiftArrow(anchored, 'b.ts', 'last');
    expect(set(toEnd.state)).toEqual(['b.ts', 'c.ts', 'd.ts']);
    expect(toEnd.state.anchor).toBe('b.ts');
    const toHome = shiftArrow(toEnd.state, toEnd.focus, 'first');
    expect(set(toHome.state)).toEqual(['a.ts', 'b.ts']);
    expect(toHome.state.anchor).toBe('b.ts');
  });

  it('clamps at the last row instead of erroring', () => {
    const at = { state: selectOne('d.ts'), focus: 'd.ts' };
    const next = shiftArrow(at.state, at.focus, 'down');
    expect(set(next.state)).toEqual(['d.ts']);
    expect(next.focus).toBe('d.ts');
  });

  it('Ctrl+Space punches a hole in a keyboard-built run and moves the anchor', () => {
    let cur = { state: selectOne('a.ts'), focus: 'a.ts' };
    cur = shiftArrow(cur.state, cur.focus, 'down');
    cur = shiftArrow(cur.state, cur.focus, 'down');
    const toggled = toggle(cur.state, 'b.ts');
    expect(set(toggled)).toEqual(['a.ts', 'c.ts']);
    expect(toggled.anchor).toBe('b.ts');
  });

  it('Ctrl+A keeps the anchor, so a follow-up Shift re-ranges from it', () => {
    let cur = { state: selectOne('b.ts'), focus: 'b.ts' };
    cur = shiftArrow(cur.state, cur.focus, 'down');
    const all = selectAll(cur.state, ORDER);
    expect(set(all)).toEqual(ORDER);
    expect(all.anchor).toBe('b.ts');
    expect(set(selectRange(all, 'a.ts', ORDER))).toEqual(['a.ts', 'b.ts']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  activePath,
  clearSelection,
  EMPTY_SELECTION,
  reconcile,
  type SelectionState,
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

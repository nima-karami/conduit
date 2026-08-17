import { describe, expect, it } from 'vitest';
import { countLabel, countNoun, resolveMenuTargets } from '../../src/menu-selection';

// The OS-standard right-click scoping rule — see
// docs/specs/2026-08-16-selection-aware-context-menus.md §2, §3.1, §14 A.
describe('resolveMenuTargets', () => {
  it('preserves the whole selection when the target is in it', () => {
    const r = resolveMenuTargets(['a', 'b', 'c'], 'b');
    expect(r.targets).toEqual(['a', 'b', 'c']);
    expect(r.collapse).toBe(false);
  });

  it('collapses to the target when it is outside the selection', () => {
    const r = resolveMenuTargets(['a', 'b'], 'z');
    expect(r.targets).toEqual(['z']);
    expect(r.collapse).toBe(true);
  });

  it('collapses to the target when nothing is selected', () => {
    const r = resolveMenuTargets([], 'a');
    expect(r.targets).toEqual(['a']);
    expect(r.collapse).toBe(true);
  });

  it('does not report a collapse for a one-item selection holding the target', () => {
    const r = resolveMenuTargets(['a'], 'a');
    expect(r.targets).toEqual(['a']);
    expect(r.collapse).toBe(false);
  });

  it('keeps the caller order for an array selection', () => {
    // Deliberately unsorted: the Explorer supplies visible (tree) order.
    expect(resolveMenuTargets(['c', 'a', 'b'], 'a').targets).toEqual(['c', 'a', 'b']);
  });

  it('keeps the caller order for a Set selection', () => {
    const set = new Set(['c', 'a', 'b']);
    expect(resolveMenuTargets(set, 'b').targets).toEqual(['c', 'a', 'b']);
  });

  it('works for non-string keys', () => {
    const r = resolveMenuTargets([1, 2, 3], 2);
    expect(r.targets).toEqual([1, 2, 3]);
    expect(r.collapse).toBe(false);
  });
});

describe('countNoun', () => {
  it('uses the singular at exactly one', () => {
    expect(countNoun(1, 'item', 'items')).toBe('1 item');
  });

  it('uses the plural above one', () => {
    expect(countNoun(3, 'item', 'items')).toBe('3 items');
  });

  it('uses the plural at zero', () => {
    expect(countNoun(0, 'item', 'items')).toBe('0 items');
  });
});

describe('countLabel', () => {
  const items = { verb: 'Delete', noun: 'items' };
  const components = { verb: 'Delete', noun: 'components' };

  it('keeps the singular label verbatim at one', () => {
    expect(countLabel('Delete', 1, items)).toBe('Delete');
    expect(countLabel('Delete component', 1, components)).toBe('Delete component');
  });

  it('keeps the singular label at zero (no count to show)', () => {
    expect(countLabel('Delete', 0, items)).toBe('Delete');
  });

  it('grows a count above one', () => {
    expect(countLabel('Delete', 3, items)).toBe('Delete 3 items');
    expect(countLabel('Delete component', 3, components)).toBe('Delete 3 components');
  });
});

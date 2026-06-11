import { describe, expect, it } from 'vitest';
import type { SessionSort } from '../../src/settings';
import {
  buildSortFilterMenuItems,
  SORT_LABELS,
  type SortFilterMenuState,
} from '../../webview/sort-filter-menu';

const build = (state: SortFilterMenuState) => buildSortFilterMenuItems(state);
const sortItems = (state: SortFilterMenuState) =>
  build(state).filter((i) => i.action?.kind === 'sort');

describe('buildSortFilterMenuItems', () => {
  it('lists every SessionSort option in SORT_LABELS order', () => {
    const ids = sortItems({ sort: 'manual', groupByProject: true }).map((i) => i.id);
    expect(ids).toEqual(SORT_LABELS.map((o) => `sort-${o.id}`));
  });

  it('marks exactly one sort option checked — the active one', () => {
    for (const { id } of SORT_LABELS) {
      const sorts = sortItems({ sort: id, groupByProject: false });
      const checked = sorts.filter((i) => i.checked);
      expect(checked).toHaveLength(1);
      expect(checked[0]?.action).toEqual({ kind: 'sort', sort: id });
    }
  });

  it('leaves non-active sort options unchecked', () => {
    const sorts = sortItems({ sort: 'name', groupByProject: true });
    const unchecked = sorts.filter((i) => i.action?.kind === 'sort' && !i.checked);
    expect(unchecked.every((i) => i.checked !== true)).toBe(true);
    expect(unchecked.length).toBe(SORT_LABELS.length - 1);
  });

  it('checks the group toggle iff grouping is on', () => {
    const groupItem = (g: boolean) =>
      build({ sort: 'manual', groupByProject: g }).find((i) => i.action?.kind === 'toggleGroup');
    expect(groupItem(true)?.checked).toBe(true);
    expect(groupItem(false)?.checked).toBe(false);
  });

  it('renders header items as disabled, action-less, never checked', () => {
    const headers = build({ sort: 'manual', groupByProject: true }).filter((i) => i.header);
    expect(headers.length).toBeGreaterThanOrEqual(2);
    for (const h of headers) {
      expect(h.action).toBeUndefined();
      expect(h.checked).toBeFalsy();
    }
  });

  it('groups the two sections with a separator before the Group header', () => {
    const list = build({ sort: 'manual', groupByProject: true });
    const groupHeader = list.find((i) => i.id === 'header-group');
    expect(groupHeader?.separatorBefore).toBe(true);
    expect(list.find((i) => i.id === 'header-sort')?.separatorBefore).toBeFalsy();
  });

  it('keeps a stable, ordered item list', () => {
    const ids = build({ sort: 'recent', groupByProject: true }).map((i) => i.id);
    expect(ids).toEqual([
      'header-sort',
      'sort-manual',
      'sort-name',
      'sort-recent',
      'sort-active',
      'sort-status',
      'sort-project',
      'header-group',
      'group-by-project',
    ]);
  });

  it('SORT_LABELS covers all SessionSort variants (no orphaned active sort)', () => {
    const all: SessionSort[] = ['manual', 'name', 'recent', 'active', 'status', 'project'];
    expect(SORT_LABELS.map((o) => o.id).sort()).toEqual([...all].sort());
  });

  it('is deterministic for a given state', () => {
    const state = { sort: 'active', groupByProject: false } as const;
    expect(build(state)).toEqual(build(state));
  });
});

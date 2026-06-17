/**
 * Pure builder for the sessions-panel sort/filter overflow menu: decides WHICH
 * items appear and their checked/header state from the current settings. The
 * component maps each spec to a `MenuItem` (check icon + real onClick).
 *
 * See docs/specs/archive/2026-06-11-sort-filter-menu.md.
 */

import type { SessionSort } from '../src/settings';

/** Sort options in display order. */
export const SORT_LABELS: { id: SessionSort; label: string }[] = [
  { id: 'manual', label: 'Manual order' },
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'recent', label: 'Recently created' },
  { id: 'active', label: 'Recently active' },
  { id: 'status', label: 'Status' },
  { id: 'project', label: 'Project' },
];

export interface SortFilterMenuState {
  sort: SessionSort;
  groupByProject: boolean;
}

/** How a (non-header) menu item mutates settings when activated. */
export type SortFilterAction = { kind: 'sort'; sort: SessionSort } | { kind: 'toggleGroup' };

export interface SortFilterMenuItemSpec {
  /** Stable id for tests and React keys. */
  id: string;
  label: string;
  /** Absent => a non-interactive faux-header. */
  action?: SortFilterAction;
  /** True => render the check icon (active/radio-selected indicator). */
  checked?: boolean;
  /** True => disabled section label (not selectable, never checked). */
  header?: boolean;
  separatorBefore?: boolean;
}

/**
 * Build the ordered menu item specs for the given settings state. Exactly one
 * sort item is checked (the active one); the group toggle is checked iff on.
 */
export function buildSortFilterMenuItems(state: SortFilterMenuState): SortFilterMenuItemSpec[] {
  const items: SortFilterMenuItemSpec[] = [{ id: 'header-sort', label: 'Sort by', header: true }];

  for (const { id, label } of SORT_LABELS) {
    items.push({
      id: `sort-${id}`,
      label,
      action: { kind: 'sort', sort: id },
      checked: state.sort === id,
    });
  }

  items.push(
    { id: 'header-group', label: 'Group', header: true, separatorBefore: true },
    {
      id: 'group-by-project',
      label: 'Group by project',
      action: { kind: 'toggleGroup' },
      checked: state.groupByProject,
    },
  );

  return items;
}

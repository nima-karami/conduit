// Pure multi-select model for the Explorer Files tree. Kept out of the React component so the
// gesture rules (toggle / range / reconcile) have a single unit-tested source of truth, like the
// tree-shape logic in file-tree.ts. Mirrors VS Code's selection semantics — see
// docs/specs/2026-06-27-explorer-multiselect.md §3 for the contract and invariants.

export interface SelectionState {
  selected: ReadonlySet<string>;
  /** The fixed point a Shift-range extends from; also the create-target source (`activePath`). */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

/** Plain click: replace the selection with one row and seat the anchor there. */
export function selectOne(path: string): SelectionState {
  return { selected: new Set([path]), anchor: path };
}

/**
 * Ctrl/Cmd click: flip `path` in the set; anchor moves to `path` even when toggled off
 * (VS Code keeps the anchor on the last Ctrl-clicked row regardless of membership).
 */
export function toggle(s: SelectionState, path: string): SelectionState {
  const next = new Set(s.selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return { selected: next, anchor: path };
}

/**
 * Shift click: select the inclusive contiguous run of `visibleOrder` between the anchor and
 * `path`; the anchor is unchanged so a follow-up Shift re-ranges from the same point. Falls
 * back to a plain select when no valid anchor exists or either endpoint isn't visible.
 */
export function selectRange(
  s: SelectionState,
  path: string,
  visibleOrder: readonly string[],
): SelectionState {
  if (s.anchor === null) return selectOne(path);
  const from = visibleOrder.indexOf(s.anchor);
  const to = visibleOrder.indexOf(path);
  if (from === -1 || to === -1) return selectOne(path);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { selected: new Set(visibleOrder.slice(lo, hi + 1)), anchor: s.anchor };
}

export function clearSelection(): SelectionState {
  return { selected: new Set(), anchor: null };
}

/** Select a known set of paths (e.g. selection follows items to their new location after a move). */
export function selectMany(paths: readonly string[]): SelectionState {
  if (paths.length === 0) return clearSelection();
  return { selected: new Set(paths), anchor: paths[paths.length - 1] };
}

/**
 * Prune any selected path no longer in `visibleOrder` (a collapse, refresh, rename, or delete
 * removed it); clear the anchor if it vanished too. Returns the same reference when nothing
 * changed so a React state update can bail out. See spec §3 invariants.
 */
export function reconcile(s: SelectionState, visibleOrder: readonly string[]): SelectionState {
  const visible = new Set(visibleOrder);
  const kept = new Set<string>();
  for (const p of s.selected) if (visible.has(p)) kept.add(p);
  const anchor = s.anchor !== null && visible.has(s.anchor) ? s.anchor : null;
  if (kept.size === s.selected.size && anchor === s.anchor) return s;
  return { selected: kept, anchor };
}

/** The active item (= anchor); drives the create-target. */
export function activePath(s: SelectionState): string | null {
  return s.anchor;
}

/**
 * Renderer-only multi-selection of agent rows (CON-167). Standard list semantics: Ctrl/Cmd toggles,
 * Shift ranges from the anchor in visible order, a plain click resets. Never persisted, so a
 * reload starts with nothing selected.
 */

export interface RowSelection {
  /** Selected session ids, in the order they were added. */
  readonly ids: readonly string[];
  /** The last plain- or Ctrl-clicked row: the origin of a Shift range. */
  readonly anchor: string | null;
}

export const NO_SELECTION: RowSelection = { ids: [], anchor: null };

/** What a row's context menu acts on beyond the row itself (CON-167). */
export interface RowMenuScope {
  /** The whole multi-selection when the right-clicked row is part of one; empty otherwise. */
  readonly selectedIds: readonly string[];
  /** Every session under a lead, for "Close all sub-agents"; empty for a row without children. */
  readonly subAgentIds: readonly string[];
}

export const NO_SCOPE: RowMenuScope = { selectedIds: [], subAgentIds: [] };

export interface RowClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

export function selectPlain(id: string): RowSelection {
  return { ids: [id], anchor: id };
}

export function applyRowClick(
  sel: RowSelection,
  id: string,
  mods: RowClickModifiers,
  visibleIds: readonly string[],
): RowSelection {
  if (mods.shift) {
    const from = sel.anchor === null ? -1 : visibleIds.indexOf(sel.anchor);
    const to = visibleIds.indexOf(id);
    if (from === -1 || to === -1) return selectPlain(id);
    const [lo, hi] = from < to ? [from, to] : [to, from];
    return { ids: visibleIds.slice(lo, hi + 1), anchor: sel.anchor };
  }
  if (mods.ctrl) {
    const ids = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id];
    return { ids, anchor: id };
  }
  return selectPlain(id);
}

/** Drops sessions that have gone. Returns the same object when nothing was removed. */
export function pruneSelection(sel: RowSelection, liveIds: ReadonlySet<string>): RowSelection {
  if (sel.ids.every((id) => liveIds.has(id))) return sel;
  const ids = sel.ids.filter((id) => liveIds.has(id));
  const anchor = sel.anchor !== null && liveIds.has(sel.anchor) ? sel.anchor : null;
  return { ids, anchor };
}

/** Every session under `id` in the agent tree, depth-first, never `id` itself. */
export function descendantIds(childrenOf: (id: string) => readonly string[], id: string): string[] {
  const out: string[] = [];
  const stack = [...childrenOf(id)].reverse();
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    out.push(cur);
    const kids = childrenOf(cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

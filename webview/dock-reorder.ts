// Pure placement decision for panel docking (drag a region onto another region).
//
// The bug this fixes: the dock drop used `moveBefore(order, source, target)`
// unconditionally, which always inserts the dragged panel *before* the target.
// That is only what the user expects when dragging leftward. Dragging a panel
// rightward onto a panel to its right would still land it *before* the target —
// so it never crossed to the target's far side and "didn't work". Re-docking was
// asymmetric (right-to-left worked, left-to-right didn't).
//
// The fix: pick the insertion side from the drag DIRECTION. Dragging rightward
// (source sits left of target) drops the panel AFTER the target; dragging leftward
// (source sits right of target) drops it BEFORE. This makes adjacent swaps and
// multi-panel moves symmetric in both directions.

/**
 * Reorder `order` by moving `sourceId` to the other side of `targetId`, choosing
 * the side from drag direction so docking is symmetric both ways:
 *   - source currently LEFT of target (dragging right) -> placed AFTER target
 *   - source currently RIGHT of target (dragging left) -> placed BEFORE target
 *
 * Returns a new array. No-op (returns the SAME array reference) when
 * `sourceId === targetId`, or when either id is absent from `order` — so callers
 * can skip a persist/host round-trip on a non-move.
 */
export function reorderDock<T extends string>(order: T[], sourceId: T, targetId: T): T[] {
  if (sourceId === targetId) return order;
  const from = order.indexOf(sourceId);
  const to = order.indexOf(targetId);
  if (from === -1 || to === -1) return order;

  const without = order.filter((id) => id !== sourceId);
  const at = without.indexOf(targetId);
  // Dragging rightward: land just past the target. Leftward: land just before it.
  const insertAt = from < to ? at + 1 : at;
  return [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];
}

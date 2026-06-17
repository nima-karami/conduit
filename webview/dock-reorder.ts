// Pure placement decision for panel docking (drag a region onto another region).
//
// Insertion side is picked from the drag DIRECTION so re-docking is symmetric:
// an unconditional insert-before only worked dragging leftward; dragging
// rightward onto a panel to its right never crossed to the target's far side.

/**
 * Reorder `order` by moving `sourceId` to the other side of `targetId` (side
 * chosen from drag direction, see above). Returns the SAME array reference on a
 * non-move (`sourceId === targetId`, or either id absent) so callers can skip a
 * persist/host round-trip.
 */
export function reorderDock<T extends string>(order: T[], sourceId: T, targetId: T): T[] {
  if (sourceId === targetId) return order;
  const from = order.indexOf(sourceId);
  const to = order.indexOf(targetId);
  if (from === -1 || to === -1) return order;

  const without = order.filter((id) => id !== sourceId);
  const at = without.indexOf(targetId);
  const insertAt = from < to ? at + 1 : at;
  return [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];
}

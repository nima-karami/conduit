/**
 * Move `dragId` to immediately before `targetId` in a list of ids. If `targetId`
 * is null or not present, `dragId` goes to the end. Returns a new array; no-op
 * when dragId === targetId or dragId is absent.
 */
export function moveBefore(ids: string[], dragId: string, targetId: string | null): string[] {
  if (dragId === targetId || !ids.includes(dragId)) return ids;
  const without = ids.filter((id) => id !== dragId);
  if (targetId === null) return [...without, dragId];
  const at = without.indexOf(targetId);
  if (at === -1) return [...without, dragId];
  return [...without.slice(0, at), dragId, ...without.slice(at)];
}

/**
 * Reorder a flat id list by whole groups. Moves every id whose group is `dragGroup`
 * as one contiguous block to immediately before the first id whose group is
 * `targetGroup`, preserving each group's internal relative order. `targetGroup`
 * null moves the block to the end. No-op (returns the input array unchanged) when
 * `dragGroup === targetGroup` or `dragGroup` has no ids — so callers can skip a
 * host round-trip. Group order is implicit: a group's position is where its first
 * id sits in `ids`.
 */
export function reorderByGroup(
  ids: string[],
  groupOf: (id: string) => string,
  dragGroup: string,
  targetGroup: string | null,
): string[] {
  if (dragGroup === targetGroup) return ids;
  const block = ids.filter((id) => groupOf(id) === dragGroup);
  if (block.length === 0) return ids;
  const rest = ids.filter((id) => groupOf(id) !== dragGroup);
  if (targetGroup === null) return [...rest, ...block];
  const at = rest.findIndex((id) => groupOf(id) === targetGroup);
  if (at === -1) return [...rest, ...block];
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

// ---------- collapse set helpers ----------

/**
 * Toggle a group key in the collapsed set: add it if absent, remove it if
 * present. Returns a new array; the input is unchanged.
 */
export function toggleCollapsed(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

// ---------- list helpers ----------

/**
 * Move `dragId` to immediately before `targetId` in a list of ids. If `targetId`
 * is null or not present, `dragId` goes to the end. Returns a new array; no-op
 * when dragId === targetId or dragId is absent.
 */
export function moveBefore<T extends string>(ids: T[], dragId: T, targetId: T | null): T[] {
  if (dragId === targetId || !ids.includes(dragId)) return ids;
  const without = ids.filter((id) => id !== dragId);
  if (targetId === null) return [...without, dragId];
  const at = without.indexOf(targetId);
  if (at === -1) return [...without, dragId];
  return [...without.slice(0, at), dragId, ...without.slice(at)];
}

type Axis = 'horizontal' | 'vertical';
type ItemBounds = { left: number; right: number; top: number; bottom: number };

export function insertionIndex(
  items: readonly ItemBounds[],
  pointer: { x: number; y: number },
  axis: Axis,
): number {
  const before = items.findIndex(({ left, right, top, bottom }) =>
    axis === 'horizontal' ? pointer.x < (left + right) / 2 : pointer.y < (top + bottom) / 2,
  );
  return before === -1 ? items.length : before;
}

export function insertionEdge(index: number | null, item: number, count: number) {
  if (index === item) return 'before';
  if (index === count && item === count - 1) return 'after';
  return undefined;
}

export function isUnchangedInsertion(source: number, index: number): boolean {
  return source >= 0 && (index === source || index === source + 1);
}

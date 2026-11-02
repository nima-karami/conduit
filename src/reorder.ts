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
export function moveBefore(ids: string[], dragId: string, targetId: string | null): string[] {
  if (dragId === targetId || !ids.includes(dragId)) return ids;
  const without = ids.filter((id) => id !== dragId);
  if (targetId === null) return [...without, dragId];
  const at = without.indexOf(targetId);
  if (at === -1) return [...without, dragId];
  return [...without.slice(0, at), dragId, ...without.slice(at)];
}

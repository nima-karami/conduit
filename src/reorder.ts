import { sortSessions } from './session-groups';
import type { SessionSort } from './settings';
import type { Project, Session } from './types';

// ---------- collapse set helpers ----------

/**
 * Toggle a group key in the collapsed set: add it if absent, remove it if
 * present. Returns a new array; the input is unchanged.
 */
export function toggleCollapsed(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

// ---------- universal drag helpers ----------

/**
 * Return the order the active `sort` yields for `ids` — the rail's own sortSessions, so
 * comparisons against the rendered order are exact. Ids absent from the map are dropped.
 */
export function sortedCanonical(
  ids: string[],
  sort: SessionSort,
  sessionsById: Map<string, Session>,
  projects: readonly Project[],
): string[] {
  const sessions = ids.map((id) => sessionsById.get(id)).filter((s): s is Session => !!s);
  return sortSessions(sessions, sort, projects).map((s) => s.id);
}

/**
 * True iff `candidate` differs from `canonical` (order-sensitive). When the
 * candidate produced by a drop is identical to the sorted canonical order, the
 * drop is a no-op: nothing should be persisted and the sort should not switch.
 */
export function dropResolvesToManual(candidate: string[], canonical: string[]): boolean {
  if (candidate.length !== canonical.length) return true;
  return candidate.some((id, i) => id !== canonical[i]);
}

/**
 * Decide whether a drag-drop reorder should be persisted. In 'manual' sort the
 * baseline is the current rendered order, so any move that changes it persists —
 * sortedCanonical returns the candidate unchanged in manual mode, so it can't be
 * the baseline (candidate-vs-itself is always a no-op). In a computed sort the
 * baseline is that sort's canonical order: a drop that stays in sort order is a
 * no-op, one that deviates persists (the caller then switches to manual).
 */
export function reorderPersists(
  candidate: string[],
  current: string[],
  sort: SessionSort,
  sessionsById: Map<string, Session>,
  projects: readonly Project[],
): boolean {
  const baseline =
    sort === 'manual' ? current : sortedCanonical(candidate, sort, sessionsById, projects);
  return dropResolvesToManual(candidate, baseline);
}

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

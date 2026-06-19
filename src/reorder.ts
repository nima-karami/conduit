import type { SessionSort } from './settings';
import type { Session, SessionStatus } from './types';

// ---------- collapse set helpers ----------

/**
 * Toggle a project path in the collapsed set: add it if absent, remove it if
 * present. Returns a new array; the input is unchanged.
 */
export function toggleCollapsed(paths: string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path];
}

// ---------- universal drag helpers ----------

const STATUS_RANK: Record<SessionStatus, number> = { running: 0, stale: 1, exited: 2 };
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/**
 * Return the order the active `sort` yields for `ids`. In 'manual' mode the
 * incoming order is already canonical. For other sorts, mirrors the comparator
 * in sidebar.tsx so comparisons against the rendered order are exact.
 */
export function sortedCanonical(
  ids: string[],
  sort: SessionSort,
  sessionsById: Map<string, Session>,
): string[] {
  if (sort === 'manual') return [...ids];
  const sessions = ids.map((id) => sessionsById.get(id)).filter((s): s is Session => !!s);
  const sorted = [...sessions];
  switch (sort) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'recent':
      sorted.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'active':
      sorted.sort(
        (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name),
      );
      break;
    case 'status':
      sorted.sort(
        (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name),
      );
      break;
    case 'project':
      sorted.sort(
        (a, b) =>
          baseName(a.projectPath).localeCompare(baseName(b.projectPath)) ||
          a.name.localeCompare(b.name),
      );
      break;
  }
  return sorted.map((s) => s.id);
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
): boolean {
  const baseline = sort === 'manual' ? current : sortedCanonical(candidate, sort, sessionsById);
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

// Pure diffstat roll-up for the Review tab (docs/specs/2026-07-02-review-changes-first-class.md
// §"Data — the diffstat"). A DOM-free fold over the SAME per-file change list the cards read
// (working = ChangeDTO from git status; commit/range = commitChangesFromFiles output), so the
// summary header and the file navigator share one source of truth and it is unit-testable.

import type { ChangeDTO } from '../src/protocol';

export interface Diffstat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Fold the review change list into `{ files, insertions, deletions }`. `files` counts every
 * change; a binary/image file contributes to the count with 0/0 lines (its `added`/`removed`
 * are already 0), matching git. Callers pass the DEDUPED file list so a staged+unstaged pair
 * (porcelain `MM`) counts once, consistent with the header's `N files changed`.
 */
export function computeDiffstat(changes: readonly ChangeDTO[]): Diffstat {
  let insertions = 0;
  let deletions = 0;
  for (const c of changes) {
    insertions += c.added;
    deletions += c.removed;
  }
  return { files: changes.length, insertions, deletions };
}

export interface ReviewProgress {
  reviewed: number;
  total: number;
  /** 0..1 — the meter's fill. 0 for an empty changeset (no division by zero). */
  fraction: number;
}

/**
 * Fold the reviewed-path set against the CURRENT file list. Counting the set directly would
 * drift the moment a reviewed file leaves the changeset (it got committed, or the source
 * switched): the meter would read `4 / 3`. Intersecting against the list keeps `reviewed`
 * bounded by `total` without having to prune the set on every rescan.
 */
export function computeReviewProgress(
  changes: readonly ChangeDTO[],
  reviewed: ReadonlySet<string>,
): ReviewProgress {
  let n = 0;
  for (const c of changes) if (reviewed.has(c.path)) n++;
  return { reviewed: n, total: changes.length, fraction: changes.length ? n / changes.length : 0 };
}

/** Add/remove one path from the reviewed set, returning a NEW set (React state identity). */
export function toggleReviewed(reviewed: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(reviewed);
  if (!next.delete(path)) next.add(path);
  return next;
}

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

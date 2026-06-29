// Pure helpers for the Review tab's COMMIT source (docs/specs/2026-06-29-review-commit-source.md).
// A commit's per-file diffs (git show, via useCommitFiles) carry no added/removed/kind, so the
// derivation that feeds the existing review card renderer lives here — DOM-free and unit-testable.

import type { ChangeDTO, ChangeKind, FileDiffDTO } from '../src/protocol';
import { computeFileReview } from '../src/review-hunks';
import type { ReviewSource } from './docs';

const IMAGE_KIND: Record<NonNullable<FileDiffDTO['image']>['status'], ChangeKind> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
};

// FileDiffDTO has no R/C status, so a rename reads as modified (or add+delete) — spec D7.
function kindOf(f: FileDiffDTO): ChangeKind {
  if (f.image) return IMAGE_KIND[f.image.status];
  if (f.head === '') return 'A';
  if (f.work === '') return 'D';
  return 'M';
}

/**
 * Derive review `ChangeDTO[]` from a commit's per-file diffs. `added`/`removed` are counted
 * from the computed hunks (approximate: preloaded diffs supply real card heights, the count
 * only feeds the `+N -N` badge + the slot estimate — spec §3.2 D4). `staged` is meaningless
 * for a commit (false). Binary/image files contribute no line counts.
 */
export function commitChangesFromFiles(files: FileDiffDTO[]): ChangeDTO[] {
  return files.map((f) => {
    let added = 0;
    let removed = 0;
    if (!f.binary && !f.image) {
      for (const hunk of computeFileReview(f.head, f.work).hunks) {
        for (const line of hunk.lines) {
          if (line.kind === 'add') added++;
          else if (line.kind === 'del') removed++;
        }
      }
    }
    return { path: f.path, added, removed, kind: kindOf(f), staged: false };
  });
}

/** Header label for the Review source. Absent (canonical working default) ⇒ working tree. */
export function reviewSourceLabel(source: ReviewSource | undefined): string {
  if (!source || source.kind === 'working') return 'Reviewing working tree';
  const short = source.sha.slice(0, 7);
  return source.subject
    ? `Reviewing commit ${short}: ${source.subject}`
    : `Reviewing commit ${short}`;
}

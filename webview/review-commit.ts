// Pure helpers for the Review tab's COMMIT source (docs/specs/2026-06-29-review-commit-source.md).
// A commit's per-file diffs (git show, via useCommitFiles) carry no added/removed/kind, so the
// derivation that feeds the existing review card renderer lives here — DOM-free and unit-testable.

import { endpointLabel } from '../src/git-range';
import type { ChangeDTO, ChangeKind, CommitNode, FileDiffDTO } from '../src/protocol';
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
  if (source.kind === 'range') {
    return `Comparing ${endpointLabel(source.base)} to ${endpointLabel(source.head)}`;
  }
  const short = source.sha.slice(0, 7);
  return source.subject
    ? `Reviewing commit ${short}: ${source.subject}`
    : `Reviewing commit ${short}`;
}

/**
 * Concise label for the picker trigger — kept minimal/clean per the user's ask
 * (docs/specs/2026-06-29-review-commit-picker.md §11). "Working tree" | "<sha7> <subject>" |
 * "<sha7>" when no subject. The subject is truncated by CSS, not here. The verbose
 * {@link reviewSourceLabel} is reserved for aria/title/announce.
 */
export function conciseSourceLabel(source: ReviewSource | undefined): string {
  if (!source || source.kind === 'working') return 'Working tree';
  if (source.kind === 'range') {
    return `${endpointLabel(source.base)}…${endpointLabel(source.head)}`;
  }
  const short = source.sha.slice(0, 7);
  return source.subject ? `${short} ${source.subject}` : short;
}

/**
 * Filter the picker's commit list (docs/specs/2026-06-29-review-commit-picker.md §3, D5):
 * case-insensitive match on sha PREFIX OR subject substring OR author substring. An empty
 * (trimmed) query matches everything. Pure — mirrors the History search fields minus date.
 */
export function filterCommitsForPicker(commits: CommitNode[], query: string): CommitNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return commits;
  return commits.filter(
    (c) =>
      c.sha.toLowerCase().startsWith(q) ||
      c.subject.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q),
  );
}

/**
 * Pasted-SHA detection (docs/specs/2026-06-29-review-commit-picker.md §3): returns the
 * lowercased sha iff the trimmed query is a 7–40-char hex string, else null. 7 is git's
 * conventional abbreviated-sha floor; 40 is a full sha. Pure.
 */
export function isPastedSha(query: string): string | null {
  const q = query.trim();
  return /^[0-9a-f]{7,40}$/i.test(q) ? q.toLowerCase() : null;
}

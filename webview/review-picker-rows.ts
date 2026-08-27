import { rangeKey, shortSha } from '../src/git-range';
import type { ResolvedRange } from '../src/range-preset';
import type { ReviewSource } from './docs';

/**
 * The Review source picker's pinned quick-picks (spec 2026-08-27-review-supercharge §2 Lane B).
 * Pure: the picker fetches, this decides. Each row selects an EXISTING source kind — Last commit
 * is the commit source for HEAD, the two ranges are the range source with the sha endpoints the
 * host resolved — so no new render path enters Review for any of them.
 *
 * A row whose input is null is simply absent: "hidden when unresolvable".
 */

export interface PinnedSourceRow {
  id: 'lastCommit' | 'unpushed' | 'branchPoint';
  label: string;
  /** Secondary line: the sha7 + subject, or what the comparison covers. */
  hint: string;
  source: ReviewSource;
}

export interface PinnedSourceInput {
  /** HEAD's commit, from the history the picker already loads. */
  head: { sha: string; subject: string } | null;
  unpushed: ResolvedRange | null;
  branchPoint: ResolvedRange | null;
}

export function buildPinnedSources(input: PinnedSourceInput): PinnedSourceRow[] {
  const rows: PinnedSourceRow[] = [];
  if (input.head) {
    const { sha, subject } = input.head;
    rows.push({
      id: 'lastCommit',
      label: 'Last commit',
      hint: subject ? `${shortSha(sha)} ${subject}` : shortSha(sha),
      source: { kind: 'commit', sha, ...(subject ? { subject } : {}) },
    });
  }
  if (input.unpushed) {
    rows.push({
      id: 'unpushed',
      label: 'Unpushed',
      hint: 'Commits that are not on the upstream branch yet',
      source: { kind: 'range', base: input.unpushed.base, head: input.unpushed.head },
    });
  }
  if (input.branchPoint) {
    rows.push({
      id: 'branchPoint',
      label: 'Since branch point',
      hint: 'Everything since this branch left the default branch',
      source: { kind: 'range', base: input.branchPoint.base, head: input.branchPoint.head },
    });
  }
  return rows;
}

export function isPinnedRowChecked(
  row: PinnedSourceRow,
  current: ReviewSource | undefined,
): boolean {
  if (!current) return false;
  if (row.source.kind === 'commit') {
    return current.kind === 'commit' && current.sha === row.source.sha;
  }
  if (row.source.kind === 'range' && current.kind === 'range') {
    return rangeKey(current.base, current.head) === rangeKey(row.source.base, row.source.head);
  }
  return false;
}

// Pure rows, filter and heading of the terminal path picker (spec 2026-10-16-terminal-path-links
// §8). The component is path-candidate-picker.tsx.
import type { ResolveRoot } from '../../src/path-link-roots';
import { elisionTail, type PathCandidate } from '../../src/path-resolve';
import { TERM_LINK_STR } from '../term-link-strings';
import type { LinkMenuAction } from '../term-menu';
import { repoTagLabel } from './repo-picker-menu';

/** At or above this many rows the picker shows a filter (spec §5). */
export const FILTER_THRESHOLD = 9;

export interface PickerRow {
  /** Unique among the picker's rows (a React key). */
  key: string;
  cand: PathCandidate;
  /** roots[rootIdx].name, or the last segment of repoRoot when outside every root. */
  repoName: string;
  /** cwd-repo and outside-root rows carry no tag. */
  tag: 'home' | 'attached' | 'nested' | 'worktree' | null;
  branch?: string;
  accessibleName: string;
  /** rootIdx === contextRootIdx (Slice 7). */
  workingHere: boolean;
}

const lastSeg = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function pickerRows(
  ranked: readonly PathCandidate[],
  roots: readonly ResolveRoot[],
  contextRootIdx?: number,
): PickerRow[] {
  return ranked.map((cand) => {
    const root = cand.rootIdx >= 0 ? roots[cand.rootIdx] : undefined;
    const repoName = root?.name ?? lastSeg(cand.repoRoot);
    const tag = root && root.kind !== 'cwd-repo' ? root.kind : null;
    const workingHere = contextRootIdx !== undefined && cand.rootIdx === contextRootIdx;
    // The row's aria-label replaces its text, so the tag pill, branch and "working here" are
    // only announced if the name carries them (QA r1 Q4).
    const extras = [
      tag === 'worktree' ? TERM_LINK_STR.worktree : tag ? repoTagLabel(tag) : null,
      root?.branch,
      workingHere ? TERM_LINK_STR.workingHere : null,
    ].filter((x): x is string => !!x);
    const named = extras.length > 0 ? `${repoName} (${extras.join(', ')})` : repoName;
    return {
      key: cand.absPath,
      cand,
      repoName,
      tag,
      ...(root?.branch ? { branch: root.branch } : {}),
      accessibleName: `${named} / ${cand.relToRoot}`,
      workingHere,
    };
  });
}

export function filterRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.accessibleName.toLowerCase().includes(q));
}

/** The focused element's accessible name, so the count is announced on open. */
export function pickerHeading(token: string, total: number, action?: LinkMenuAction): string {
  return action
    ? TERM_LINK_STR.pickFor(TERM_LINK_STR[action])
    : TERM_LINK_STR.heading(token, total);
}

/** What "Search all files…" looks for: an elided token's concrete tail, since quick open has no
 *  file named `…`. */
export function searchQueryOf(token: string): string {
  return elisionTail(token) ?? token;
}

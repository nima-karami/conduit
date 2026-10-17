// Pure rows, filter and heading of the terminal path picker (spec 2026-10-16-terminal-path-links
// §8). The component is path-candidate-picker.tsx.
import type { ResolveRoot } from '../../src/path-link-roots';
import type { PathCandidate } from '../../src/path-resolve';
import { TERM_LINK_STR } from '../term-link-strings';

/** At or above this many rows the picker shows a filter (spec §5). */
export const FILTER_THRESHOLD = 9;

export interface PickerRow {
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
    return {
      cand,
      repoName,
      tag,
      ...(root?.branch ? { branch: root.branch } : {}),
      accessibleName: `${repoName} / ${cand.relToRoot}`,
      workingHere: contextRootIdx !== undefined && cand.rootIdx === contextRootIdx,
    };
  });
}

export function filterRows(rows: readonly PickerRow[], query: string): PickerRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.accessibleName.toLowerCase().includes(q));
}

/** The focused element's accessible name, so the count is announced on open. */
export function pickerHeading(token: string, total: number, actionLabel?: string): string {
  return actionLabel ? TERM_LINK_STR.pickFor(actionLabel) : TERM_LINK_STR.heading(token, total);
}

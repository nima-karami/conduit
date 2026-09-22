// What a scope means for a diff TAB: routing, title, cache key. See spec
// 2026-09-22-scoped-diff-tabs §2–§3.

import type { ChangeDTO, DiffTabScope } from '../src/protocol';
import { diffKey } from './review-scope';

type ChangeSide = Pick<ChangeDTO, 'staged' | 'conflicted'>;

export const DIFF_SCOPE_SUFFIX: Record<DiffTabScope, string> = {
  staged: ' (Index)',
  unstaged: ' (Working Tree)',
};

export function diffTabTitle(name: string, scope: DiffTabScope): string {
  return `${name}${DIFF_SCOPE_SUFFIX[scope]}`;
}

/** A conflicted path has no stage-0 index blob, so neither narrowed side exists (§13 D3). */
export function diffScopeForChange(change: ChangeSide): DiffTabScope | undefined {
  if (change.conflicted) return undefined;
  return change.staged ? 'staged' : 'unstaged';
}

export function changeRowTooltip(change: ChangeSide): string {
  const scope = diffScopeForChange(change);
  if (scope === 'staged') return 'Open staged diff';
  if (scope === 'unstaged') return 'Open unstaged diff';
  return 'Open diff';
}

export function diffTabKey(doc: { path: string; diffScope?: DiffTabScope }): string {
  return diffKey(doc.path, doc.diffScope ?? 'all');
}

// What a scope means for a diff TAB: routing, title, cache key. See spec
// 2026-09-22-scoped-diff-tabs §2–§3.

import type { ChangeDTO, DiffTabScope, FileDiffDTO } from '../src/protocol';
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

export type DiffTabState =
  | 'loading'
  | 'error'
  | 'conflicted'
  | 'oversize'
  | 'image'
  | 'binary'
  | 'empty'
  | 'populated';

/** Which of spec §2's states a diff tab renders. An unmerged read has `head === work === ''`, so
 *  conflicted has to be decided before empty. */
export function diffTabState(
  diff: FileDiffDTO | undefined,
  scope: DiffTabScope | undefined,
): DiffTabState {
  if (!diff) return 'loading';
  if (diff.error !== undefined) return 'error';
  if (scope && diff.unmerged) return 'conflicted';
  if (diff.oversize) return 'oversize';
  if (diff.image) return 'image';
  if (diff.binary) return 'binary';
  if (scope && diff.head === diff.work) return 'empty';
  return 'populated';
}

// Copy lives here because the app has no string-externalisation layer (spec §10). Each notice
// is one whole template per scope so word order can change per locale.
const EMPTY_SIDE_NOTICE: Record<DiffTabScope, (name: string) => string> = {
  staged: (name) => `No staged changes in ${name}.`,
  unstaged: (name) => `No unstaged changes in ${name}.`,
};

export function emptySideNotice(scope: DiffTabScope, name: string): string {
  return EMPTY_SIDE_NOTICE[scope](name);
}

export const CONFLICTED_NOTICE = 'Conflicted file — there is no staged version to compare against.';
export const DIFF_READ_ERROR_NOTICE = "Couldn't read this diff.";

import type { GroupIndex } from './doc-groups';
import { type OpenDoc, pinnedIdForMove } from './docs';
import { tabStateKey } from './editor-group-context';
import { clearHtmlView, copyHtmlView, moveHtmlView } from './html-view-store';
import { clearReveal, moveReveal } from './project-index';
import { copyViewState, fileViewStateIds, markClosing, moveViewState } from './view-state-store';

type TabDoc = Pick<OpenDoc, 'id' | 'kind' | 'path'>;

/** Every id a tab's viewers keep view state under, as group 1 spells it (split-editor plan P5). */
export function tabViewStateIds(doc: TabDoc): string[] {
  return doc.kind === 'file' ? fileViewStateIds(doc.path) : [doc.id];
}

/** A tab's per-group view state goes with it to the other group, or starts there as a copy
 *  (split-editor plan P5, I10). */
export function carryTabState(
  doc: TabDoc,
  from: GroupIndex,
  to: GroupIndex,
  how: 'move' | 'copy',
): void {
  const carry = how === 'move' ? moveViewState : copyViewState;
  for (const id of tabViewStateIds(doc)) carry(tabStateKey(id, from), tabStateKey(id, to));
  if (how === 'move' && doc.kind === 'file') moveReveal(doc.path, from, to);
  (how === 'move' ? moveHtmlView : copyHtmlView)(
    tabStateKey(doc.id, from),
    tabStateKey(doc.id, to),
  );
}

/** The reducer re-keys a `commit-diff` slot before a split or move lands it (split-editor plan
 *  P4), so its view state in both groups is re-keyed first. Returns the doc as it will land. */
export function pinTabStateForMove<T extends TabDoc>(doc: T): T {
  const id = pinnedIdForMove(doc);
  if (id === doc.id) return doc;
  const pinned = { ...doc, id };
  const to = tabViewStateIds(pinned);
  for (const g of [1, 2] as const) {
    tabViewStateIds(doc).forEach((from, i) => {
      moveViewState(tabStateKey(from, g), tabStateKey(to[i], g));
    });
  }
  return pinned;
}

/** The tab of `doc` in `group` is closing: evict its view state and tombstone it against the
 *  closing viewer's late capture. */
export function dropTabState(doc: TabDoc, group: GroupIndex): void {
  for (const id of tabViewStateIds(doc)) markClosing(tabStateKey(id, group));
  clearHtmlView(tabStateKey(doc.id, group));
  dropStagedReveal(doc, group);
}

function dropStagedReveal(doc: TabDoc, group: GroupIndex): void {
  if (doc.kind === 'file') clearReveal(doc.path, group);
}

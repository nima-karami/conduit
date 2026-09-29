import type { RepoHeadModel } from '../src/changes-view-model';
import { folderKey } from '../src/folder-key';
import type { ChangeDTO } from '../src/protocol';
import type { ActiveTarget } from './active-target';
import { joinPath } from './file-tree';

export interface HighlightedChange {
  root: string;
  side: 'staged' | 'unstaged';
  path: string;
}

/** The one Changes row the target maps to. Callers pass only VISIBLE heads — that filter is what
 *  keeps a collapsed repo unhighlighted (see changes-active-highlight spec §2, D3). */
export function highlightedChange(
  heads: readonly RepoHeadModel[],
  target: ActiveTarget | null,
): HighlightedChange | null {
  if (target === null) return null;
  const sides: ('staged' | 'unstaged')[] =
    target.side === 'either' ? ['unstaged', 'staged'] : [target.side];
  for (const head of heads) {
    if (head.changes === undefined) continue;
    const root = head.repo.root;
    const hit = (c: ChangeDTO) => folderKey(joinPath(root, c.path)) === target.key;
    for (const side of sides) {
      const change = head[side].find(hit);
      if (change) return { root, side, path: change.path };
    }
  }
  return null;
}

/** Stable identity for scroll-on-change: equal highlights give equal ids whatever the root spelling. */
export function highlightId(h: HighlightedChange | null): string | null {
  return h === null ? null : `${folderKey(h.root)}|${h.side}|${h.path}`;
}

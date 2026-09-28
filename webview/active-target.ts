import { folderKey } from '../src/folder-key';
import type { DiffTabScope } from '../src/protocol';
import type { CenterView } from './center-view';
import type { DocKind } from './docs';

export type ActiveTargetSide = 'staged' | 'unstaged' | 'either';

/** The file the focused editor tab shows — the one value both Changes and Files follow. */
export interface ActiveTarget {
  /** The doc's path exactly as the tab holds it (canonicalPath spelling). */
  path: string;
  /** folderKey(path): the only form either panel compares on. */
  key: string;
  side: ActiveTargetSide;
}

/** See changes-active-highlight spec §2 "Tab kind → Changes row mapping". */
export function activeTarget(
  doc: { kind: DocKind; path: string; diffScope?: DiffTabScope } | null,
  centerView: CenterView,
): ActiveTarget | null {
  if (doc === null || centerView !== 'editor') return null;
  let side: ActiveTargetSide;
  if (doc.kind === 'file') side = 'either';
  else if (doc.kind === 'diff') side = doc.diffScope ?? 'either';
  else return null;
  return { path: doc.path, key: folderKey(doc.path), side };
}

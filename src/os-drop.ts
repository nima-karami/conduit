import { topLevelPaths } from './drop-intent';
import { folderKey } from './folder-key';
import { findFolderConflict } from './folder-validation';
import { isAncestorOf } from './owning-session';

/** One DataTransfer item as captured inside the `drop` event (the items die after it). */
export interface DropItemLike {
  path: string;
  entry: { isDirectory: boolean } | null;
}

/** `isDir: null` = the entry API couldn't say; the caller asks the host (`folder:probe`). */
export interface DroppedPath {
  path: string;
  isDir: boolean | null;
}

export function mapDropItems(items: readonly DropItemLike[]): DroppedPath[] {
  return items.flatMap((it) =>
    it.path === '' ? [] : [{ path: it.path, isDir: it.entry ? it.entry.isDirectory : null }],
  );
}

export interface OsDropPlan {
  attach: string[];
  copy: string[];
}

/** mf-files spec §2.7: dropped folders outside every session folder can attach (D4, D5);
 *  everything else copies, except what sits inside a folder being attached (D17). */
export function planOsDrop(
  items: readonly { path: string; isDir: boolean }[],
  sessionFolders: readonly string[],
): OsDropPlan {
  const keys = sessionFolders.map(folderKey);
  const attach = topLevelPaths(items.filter((i) => i.isDir).map((i) => i.path)).filter(
    (d) => findFolderConflict(folderKey(d), keys) === null,
  );
  const attachKeys = attach.map(folderKey);
  const copy = topLevelPaths(items.map((i) => i.path)).filter((p) => {
    const k = folderKey(p);
    return !attachKeys.some((a) => isAncestorOf(a, k));
  });
  return { attach, copy };
}

import { folderKey } from './folder-key';

// After folderKey: '' is posix `/`, `C:` a drive (case is folded only when a path follows),
// `//host/share` a UNC share — and `//?/c:`, a long-path drive, has that same shape.
const FILESYSTEM_ROOT = /^(|[a-z]:|\/\/[^/]+\/[^/]+)$/i;

/**
 * Whether a recursive watch on `dir` would be a watch on everything the user owns: a home
 * directory or a filesystem root. Their churn (AppData, browser caches) never stops: every event
 * re-walked the folder's file index and every buffer overflow was a "can't trust these events"
 * recheck, so an idle app held 15-41% of a core in main. Such a folder gets a top-level watch only.
 */
export function isBroadWatchRoot(dir: string, homeDir: string | undefined): boolean {
  const k = folderKey(dir);
  return FILESYSTEM_ROOT.test(k) || (!!homeDir && k === folderKey(homeDir));
}

// Agents' dotfile churn in home re-walked home on every write (CON-5).
export function isBroadRootDotfileEvent(filename: string): boolean {
  return filename.length > 0 && !/[\\/]/.test(filename) && filename.startsWith('.');
}

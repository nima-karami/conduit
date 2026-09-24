import { folderKey } from './folder-key';
import { isAncestorOf } from './owning-session';
import type { Session } from './types';

export function presentRoots(s: Pick<Session, 'roots' | 'missingRoots'>): string[] {
  const missing = new Set((s.missingRoots ?? []).map(folderKey));
  return s.roots.filter((r) => !missing.has(folderKey(r)));
}

/** The folders the project watcher registers for a `requestProject` (mf-model spec §2.6). */
export function watchFoldersFor(p: string, s: Session | undefined): string[] {
  const folders = s ? [p, ...(s.homeMissing ? [] : [s.home]), ...presentRoots(s)] : [p];
  return folders.filter((f) => f !== '');
}

export function sessionHasFolderKey(s: Pick<Session, 'home' | 'roots'>, key: string): boolean {
  return folderKey(s.home) === key || s.roots.some((r) => folderKey(r) === key);
}

export function sessionContains(s: Pick<Session, 'home' | 'roots'>, p: string): boolean {
  const k = folderKey(p);
  return [s.home, ...s.roots].some((f) => isAncestorOf(folderKey(f), k));
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { topLevelPaths } from './drop-intent';
import { folderKey } from './folder-key';
import { isInsideAnyRoot, realPathLeaf } from './path-guard';
import { presentRoots } from './session-folders';
import type { Session } from './types';

export type DragOutRefusal =
  | 'bad-request'
  | 'unknown-session'
  | 'outside-folders'
  | 'folder-missing'
  | 'symlink-escape'
  | 'missing'
  | 'too-many';
export const MAX_OUTGOING_PATHS = 500;
export interface OutgoingFolders {
  present: string[];
  missing: string[];
}
export interface OutgoingPathDeps {
  /** realPathLeaf semantics. */
  realpath(p: string): string;
  exists(p: string): boolean;
  /** The dedupe key folds case; true on win32. */
  caseInsensitive: boolean;
}
export type OutgoingVerdict =
  | { ok: true; paths: string[] }
  | { ok: false; reason: DragOutRefusal; path?: string };

export function outgoingFoldersFor(
  s: Pick<Session, 'home' | 'roots' | 'missingRoots' | 'homeMissing'>,
): OutgoingFolders {
  return {
    present: [...(s.homeMissing ? [] : [s.home]), ...presentRoots(s)],
    missing: [...(s.missingRoots ?? []), ...(s.homeMissing ? [s.home] : [])],
  };
}

function dedupe(paths: readonly string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = caseInsensitive ? folderKey(p).toLowerCase() : folderKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** See os-drag-out plan, Contracts "Validation order": first failure wins and refuses the whole
 *  request. */
export function validateOutgoingPaths(
  paths: unknown,
  folders: OutgoingFolders,
  deps: OutgoingPathDeps,
): OutgoingVerdict {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string')) {
    return { ok: false, reason: 'bad-request' };
  }
  if (paths.length > MAX_OUTGOING_PATHS) return { ok: false, reason: 'too-many' };
  const raw = paths as string[];
  const relative = raw.find((p) => !path.isAbsolute(p));
  if (relative !== undefined) return { ok: false, reason: 'bad-request', path: relative };
  // Case variants must collapse before topLevelPaths, which would drop both against each other.
  const top = topLevelPaths(dedupe(raw, deps.caseInsensitive));
  for (const p of top) {
    if (isInsideAnyRoot(p, folders.present)) continue;
    const reason = isInsideAnyRoot(p, folders.missing) ? 'folder-missing' : 'outside-folders';
    return { ok: false, reason, path: p };
  }
  const realPresent = folders.present.map((f) => deps.realpath(f));
  for (const p of top) {
    if (!isInsideAnyRoot(deps.realpath(p), realPresent)) {
      return { ok: false, reason: 'symlink-escape', path: p };
    }
  }
  const gone = top.find((p) => !deps.exists(p));
  if (gone !== undefined) return { ok: false, reason: 'missing', path: gone };
  return { ok: true, paths: top };
}

export function nodeOutgoingPathDeps(platform: NodeJS.Platform): OutgoingPathDeps {
  return {
    realpath: realPathLeaf,
    exists: (p) => {
      try {
        fs.statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    caseInsensitive: platform === 'win32',
  };
}

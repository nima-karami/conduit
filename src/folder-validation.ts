import { folderKey } from './folder-key';
import { isAncestorOf } from './owning-session';

export type SessionOpReason =
  | 'unknown-session'
  | 'invalid-path'
  | 'not-found'
  | 'not-a-directory'
  | 'filesystem-root'
  | 'duplicate'
  | 'overlaps'
  | 'is-home'
  | 'not-attached'
  | 'unknown-project'
  | 'too-many';

export interface DroppedRoot {
  path: string;
  reason: SessionOpReason;
}

export const MAX_ROOTS = 32;
const MAX_FOLDER_PATH = 4096;

export interface FolderProbeDeps {
  path: {
    isAbsolute(p: string): boolean;
    resolve(...p: string[]): string;
    parse(p: string): { root: string };
  };
  kind: (p: string) => Promise<'dir' | 'not-dir' | 'missing'>;
  realpath: (p: string) => Promise<string>;
}

export type ProbedFolder =
  | { status: 'present'; stored: string; key: string; realKey: string }
  | { status: 'missing'; stored: string; key: string };

/** See mf-model spec §3.3 "A folder path". A missing folder gets lexical checks only (S12). */
export async function probeFolder(
  raw: unknown,
  deps: FolderProbeDeps,
): Promise<ProbedFolder | { reason: 'invalid-path' | 'not-a-directory' | 'filesystem-root' }> {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_FOLDER_PATH ||
    raw.includes('\0') ||
    !deps.path.isAbsolute(raw)
  ) {
    return { reason: 'invalid-path' };
  }
  const stored = deps.path.resolve(raw);
  const isFsRoot = (p: string) => deps.path.parse(p).root === p;
  if (isFsRoot(stored)) return { reason: 'filesystem-root' };
  const key = folderKey(stored);
  const kind = await deps.kind(stored);
  if (kind === 'not-dir') return { reason: 'not-a-directory' };
  if (kind === 'missing') return { status: 'missing', stored, key };
  let real: string;
  try {
    real = await deps.realpath(stored);
  } catch {
    // Deleted between the stat and the realpath: it is missing now.
    return { status: 'missing', stored, key };
  }
  if (isFsRoot(real)) return { reason: 'filesystem-root' };
  return { status: 'present', stored, key, realKey: folderKey(real) };
}

export type FolderConflict = { kind: 'duplicate' | 'inside' | 'contains'; index: number };

/** The one folder-conflict rule (locked L11); the dialog and `placementConflict` both read it.
 *  A duplicate anywhere wins over an earlier overlap. */
export function findFolderConflict(
  candidateKey: string,
  existingKeys: readonly string[],
): FolderConflict | null {
  const dup = existingKeys.indexOf(candidateKey);
  if (dup >= 0) return { kind: 'duplicate', index: dup };
  for (let index = 0; index < existingKeys.length; index++) {
    const e = existingKeys[index];
    if (isAncestorOf(e, candidateKey)) return { kind: 'inside', index };
    if (isAncestorOf(candidateKey, e)) return { kind: 'contains', index };
  }
  return null;
}

export function placementConflict(
  candidate: readonly string[],
  existing: readonly string[],
): 'duplicate' | 'overlaps' | null {
  const conflicts = candidate.map((c) => findFolderConflict(c, existing));
  if (conflicts.some((c) => c?.kind === 'duplicate')) return 'duplicate';
  return conflicts.some((c) => c !== null) ? 'overlaps' : null;
}

export function folderKeysOf(
  folders: readonly string[],
  realKeys: ReadonlyMap<string, string>,
): string[] {
  return folders.flatMap((f) => {
    const key = folderKey(f);
    const real = realKeys.get(key);
    return real && real !== key ? [key, real] : [key];
  });
}

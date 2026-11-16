import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasDotSegment } from '../canonical-path';
import { isInsideAnyRoot, isInsideRoot, realPathLeaf } from '../path-guard';
import { isDenied } from './fs-deny';

export type ConfineResult =
  | { ok: true; real: string }
  | { ok: false; code: 'refused' | 'not_found' };

const refused: ConfineResult = { ok: false, code: 'refused' };

/**
 * Where a path a peer names may be read from (spec 5.3, plan decision 4). B is the only judge: the
 * lexical check rejects escapes cheaply, the real-path check closes the symlink hole. A path that
 * does not exist is `not_found` only when it would lie inside the roots; a dangling symlink is
 * refused, because its target is outside what the lexical check looked at.
 */
export interface ConfineOptions {
  /**
   * A file deleted since the diff was taken names a path that is gone. Its parent must still be a
   * real folder inside the roots; only then is the missing leaf allowed through (a deleted file's
   * diff needs its HEAD blob, plan 2026-11-16-remote-ssh-git).
   */
  allowMissing?: boolean;
}

export async function confineFsPath(
  target: string,
  roots: readonly string[],
  opts: ConfineOptions = {},
): Promise<ConfineResult> {
  if (!path.isAbsolute(target)) return refused;
  // A `..` segment defeats the string-prefix containment below, so it is refused before resolving.
  if (hasDotSegment(target)) return refused;
  if (isDenied(target)) return refused;
  const abs = path.resolve(target);
  if (!isInsideAnyRoot(abs, roots)) return refused;

  const real = realPathLeaf(abs);
  if (isDenied(real)) return refused;
  if (!roots.some((root) => isInsideRoot(real, realPathLeaf(root)))) return refused;

  const existence = await existsOrDangling(abs);
  if (existence === 'dangling') return refused;
  if (existence === 'missing') {
    if (!opts.allowMissing) return { ok: false, code: 'not_found' };
    return confineMissingLeaf(abs, roots);
  }
  return { ok: true, real };
}

/**
 * A missing leaf is judged by its parent alone: there is nothing to read, so the only thing that
 * can leak is where the parent really is. Re-resolving the parent (not trusting the walk-up that
 * realPathLeaf did) keeps this safe if that walk-up ever changes.
 */
async function confineMissingLeaf(abs: string, roots: readonly string[]): Promise<ConfineResult> {
  let realParent: string;
  try {
    realParent = await fs.promises.realpath(path.dirname(abs));
    if (!(await fs.promises.stat(realParent)).isDirectory()) {
      return { ok: false, code: 'not_found' };
    }
  } catch (err) {
    // A parent that is absent is simply not there; any other failure to resolve it is not trusted.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { ok: false, code: 'not_found' } : refused;
  }
  if (!roots.some((root) => isInsideRoot(realParent, realPathLeaf(root)))) return refused;
  const leaf = path.join(realParent, path.basename(abs));
  if (isDenied(leaf)) return refused;
  return { ok: true, real: leaf };
}

/** `exists` when the path resolves, `missing` when nothing is there, `dangling` for a link to nothing. */
async function existsOrDangling(abs: string): Promise<'exists' | 'missing' | 'dangling'> {
  try {
    await fs.promises.realpath(abs);
    return 'exists';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'dangling';
    try {
      await fs.promises.lstat(abs);
      return 'dangling';
    } catch {
      return 'missing';
    }
  }
}

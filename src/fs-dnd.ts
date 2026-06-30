import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueDestPath } from './fs-import';
import { isInsideAnyRoot, realPathLeaf } from './path-guard';

/**
 * Guarded filesystem move/copy operations for drag-and-drop (D5).
 *
 * Both `from` and `to` must pass the path-guard containment check (same
 * two-stage defence as fs-mutations: lexical first, symlink-resolved second)
 * before any disk mutation runs. Out-of-root attempts are refused.
 *
 * Move:  fs.rename (fast, same filesystem); falls back to copy+unlink across
 *        devices (EXDEV). Recursive via cp then rm.
 * Copy:  fs.cp with { recursive: true }.
 *
 * Conflict policy (spec 2026-06-29-explorer-dnd-rename-polish §3):
 *  - 'error'   (default, back-compat): destination exists → refuse with a
 *              discriminable `code:'EEXIST'` so the renderer can open the
 *              Replace/Keep both/Cancel dialog instead of toasting.
 *  - 'replace': remove the existing destination first, then move/copy.
 *  - 'rename':  write to a non-colliding `name (n)` path (Keep both); the
 *              returned `path` is the actual destination created.
 */

export type ConflictPolicy = 'error' | 'replace' | 'rename';

export type DndResult = { ok: true; path: string } | { ok: false; error: string; code?: 'EEXIST' };

export interface DndOpts {
  onConflict?: ConflictPolicy;
}

/** Containment check mirroring fs-mutations.contained() */
function contained(target: string, roots: readonly string[]): boolean {
  const abs = path.resolve(target);
  if (!isInsideAnyRoot(abs, roots)) return false;
  return isInsideAnyRoot(realPathLeaf(abs), roots);
}

/** True when `child` is inside (or equal to) `ancestor` — guards a replace that would eat the source. */
function isInsideOrEqual(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the effective destination given the conflict policy, or a typed outcome the caller
 * returns as-is. On 'replace' the existing dest is removed here (after the source-containment
 * guard). Returns `{ dest }` to proceed, or `{ result }` to short-circuit.
 */
async function resolveConflict(
  absFrom: string,
  absTo: string,
  policy: ConflictPolicy,
): Promise<{ dest: string } | { result: DndResult }> {
  if (!fs.existsSync(absTo)) return { dest: absTo };
  if (policy === 'rename') {
    return {
      dest: uniqueDestPath(path.dirname(absTo), path.basename(absTo), (p) => fs.existsSync(p)),
    };
  }
  if (policy === 'replace') {
    if (isInsideOrEqual(absFrom, absTo)) {
      return {
        result: { ok: false, error: `Cannot replace a folder that contains the item: ${absTo}` },
      };
    }
    await fs.promises.rm(absTo, { recursive: true, force: true });
    return { dest: absTo };
  }
  return { result: { ok: false, code: 'EEXIST', error: `Destination already exists: ${absTo}` } };
}

/**
 * Move `from` to `to` (both paths validated against `roots`).
 * Uses fs.rename; falls back to recursive copy + rm on EXDEV (cross-device).
 */
export async function fsMove(
  from: string,
  to: string,
  roots: readonly string[],
  opts: DndOpts = {},
): Promise<DndResult> {
  if (!from || !to) return { ok: false, error: 'Both source and destination are required.' };
  if (roots.length === 0) return { ok: false, error: 'No open workspace to act in.' };

  // Stage 1: lexical + real-path containment for both ends.
  if (!contained(from, roots)) {
    return { ok: false, error: `Refusing to act outside the workspace: ${from}` };
  }
  if (!contained(to, roots)) {
    return { ok: false, error: `Refusing to act outside the workspace: ${to}` };
  }

  const absFrom = path.resolve(from);
  const conflict = await resolveConflict(absFrom, path.resolve(to), opts.onConflict ?? 'error');
  if ('result' in conflict) return conflict.result;
  const absTo = conflict.dest;

  try {
    await fs.promises.mkdir(path.dirname(absTo), { recursive: true });
    await fs.promises.rename(absFrom, absTo);
    return { ok: true, path: absTo };
  } catch (e: unknown) {
    // EXDEV: source and destination are on different filesystems (or drives on Windows).
    // Fall back to a recursive copy followed by a recursive delete of the source.
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'EXDEV') {
      try {
        await fs.promises.cp(absFrom, absTo, { recursive: true });
        await fs.promises.rm(absFrom, { recursive: true, force: true });
        return { ok: true, path: absTo };
      } catch (e2: unknown) {
        return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) };
      }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Copy `from` to `to` (both paths validated against `roots`).
 * Recursive — works for both files and folders.
 */
export async function fsCopy(
  from: string,
  to: string,
  roots: readonly string[],
  opts: DndOpts = {},
): Promise<DndResult> {
  if (!from || !to) return { ok: false, error: 'Both source and destination are required.' };
  if (roots.length === 0) return { ok: false, error: 'No open workspace to act in.' };

  // Stage 1: lexical + real-path containment for both ends.
  if (!contained(from, roots)) {
    return { ok: false, error: `Refusing to act outside the workspace: ${from}` };
  }
  if (!contained(to, roots)) {
    return { ok: false, error: `Refusing to act outside the workspace: ${to}` };
  }

  const absFrom = path.resolve(from);
  const conflict = await resolveConflict(absFrom, path.resolve(to), opts.onConflict ?? 'error');
  if ('result' in conflict) return conflict.result;
  const absTo = conflict.dest;

  try {
    await fs.promises.mkdir(path.dirname(absTo), { recursive: true });
    await fs.promises.cp(absFrom, absTo, { recursive: true });
    return { ok: true, path: absTo };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

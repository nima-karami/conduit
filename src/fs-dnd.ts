import * as fs from 'node:fs';
import * as path from 'node:path';
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
 * Overwrite policy: if the destination already exists, we REFUSE — no silent
 * clobber. The caller may retry with a different name if desired.
 */

export type DndResult = { ok: true; path: string } | { ok: false; error: string };

/** Containment check mirroring fs-mutations.contained() */
function contained(target: string, roots: readonly string[]): boolean {
  const abs = path.resolve(target);
  if (!isInsideAnyRoot(abs, roots)) return false;
  return isInsideAnyRoot(realPathLeaf(abs), roots);
}

/**
 * Move `from` to `to` (both paths validated against `roots`).
 * Uses fs.rename; falls back to recursive copy + rm on EXDEV (cross-device).
 */
export async function fsMove(
  from: string,
  to: string,
  roots: readonly string[],
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
  const absTo = path.resolve(to);

  // Refuse to overwrite an existing destination.
  if (fs.existsSync(absTo)) {
    return { ok: false, error: `Destination already exists: ${to}` };
  }

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
  const absTo = path.resolve(to);

  // Refuse to overwrite an existing destination.
  if (fs.existsSync(absTo)) {
    return { ok: false, error: `Destination already exists: ${to}` };
  }

  try {
    await fs.promises.mkdir(path.dirname(absTo), { recursive: true });
    await fs.promises.cp(absFrom, absTo, { recursive: true });
    return { ok: true, path: absTo };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

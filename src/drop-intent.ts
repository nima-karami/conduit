import * as path from 'node:path';

/**
 * Drop-intent helper (D5). Pure, no fs/Electron.
 *
 * Given a drag source and a folder target, computes whether the drop is a
 * move or copy (Ctrl = copy, default = move, Shift/Alt = move) and the
 * destination absolute path. Returns null for invalid / no-op drops so the
 * caller can bail out cleanly without touching disk.
 */

export interface DropInput {
  source: string;
  targetDir: string;
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean };
}

export interface DropResult {
  op: 'move' | 'copy';
  dest: string;
}

/**
 * Normalize a path: resolve forward/back slashes and trailing separators so
 * comparisons work on Windows (where paths may use backslashes).
 */
function norm(p: string): string {
  // Replace all backslashes with forward slashes, then resolve via path.
  // On Windows, path.resolve uses backslashes; we use the OS separator.
  return path.resolve(p.replace(/\\/g, path.sep).replace(/\//g, path.sep));
}

/**
 * True when `ancestor` is a proper ancestor of (or equal to) `child`.
 * Used to detect descendant-drop: can't move a folder into itself or its own subtree.
 */
function isAncestorOrEqual(ancestor: string, child: string): boolean {
  const a = norm(ancestor);
  const c = norm(child);
  if (process.platform === 'win32') {
    const al = a.toLowerCase();
    const cl = c.toLowerCase();
    return cl === al || cl.startsWith(al + path.sep);
  }
  return c === a || c.startsWith(a + path.sep);
}

/**
 * Compute the drop intent for a drag-and-drop operation in the file tree.
 *
 * Returns null (no-op) when:
 *  - source === targetDir (dropping a folder onto itself)
 *  - dropping a folder into one of its own descendants
 *  - the computed dest === source (same location, rename would be a no-op)
 *
 * Modifier rules:
 *  - Ctrl = copy
 *  - Shift / Alt = move (no link/shortcut semantics in-app)
 *  - default (none) = move
 */
export function dropIntent(input: DropInput): DropResult | null {
  const { source, targetDir, modifiers } = input;

  const normSource = norm(source);
  const normTarget = norm(targetDir);

  // Can't drop a folder onto itself.
  if (process.platform === 'win32') {
    if (normSource.toLowerCase() === normTarget.toLowerCase()) return null;
  } else {
    if (normSource === normTarget) return null;
  }

  // Can't drop a folder into its own descendant (or itself as a folder target).
  if (isAncestorOrEqual(normSource, normTarget)) return null;

  const baseName = path.basename(normSource);
  const dest = path.join(normTarget, baseName);
  const normDest = norm(dest);

  // Dropping into the same directory the source already lives in is a no-op.
  if (process.platform === 'win32') {
    if (normDest.toLowerCase() === normSource.toLowerCase()) return null;
  } else {
    if (normDest === normSource) return null;
  }

  const op: 'move' | 'copy' = modifiers.ctrl ? 'copy' : 'move';

  return { op, dest };
}

/**
 * Drop-intent helper (D5). Pure, no fs/Electron, no Node.js built-ins —
 * safe to bundle in the browser renderer.
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

/** Detect Windows-style paths (drive letter or UNC prefix). */
function isWin(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Normalize a path: collapse all separators to '/' and strip trailing slash.
 * We use forward-slash consistently so comparisons are simple.
 */
function norm(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

/** Extract the last path segment (basename). */
function basename(p: string): string {
  const n = norm(p);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(idx + 1) : n;
}

/** Join path segments with a single '/'. */
function join(...parts: string[]): string {
  return parts
    .map((p, i) =>
      i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+/, '').replace(/[\\/]+$/, ''),
    )
    .join('/');
}

/**
 * True when `ancestor` is a proper ancestor of (or equal to) `child`.
 * Used to detect descendant-drop: can't move a folder into itself or its own subtree.
 */
function isAncestorOrEqual(ancestor: string, child: string): boolean {
  const a = norm(ancestor);
  const c = norm(child);
  const win = isWin(a) || isWin(c);
  if (win) {
    const al = a.toLowerCase();
    const cl = c.toLowerCase();
    return cl === al || cl.startsWith(`${al}/`);
  }
  return c === a || c.startsWith(`${a}/`);
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

  const win = isWin(source) || isWin(targetDir);

  // Can't drop a folder onto itself.
  if (win) {
    if (normSource.toLowerCase() === normTarget.toLowerCase()) return null;
  } else {
    if (normSource === normTarget) return null;
  }

  // Can't drop a folder into its own descendant (or itself as a folder target).
  if (isAncestorOrEqual(normSource, normTarget)) return null;

  const base = basename(normSource);
  const dest = join(normTarget, base);
  const normDest = norm(dest);

  // Dropping into the same directory the source already lives in is a no-op.
  if (win) {
    if (normDest.toLowerCase() === normSource.toLowerCase()) return null;
  } else {
    if (normDest === normSource) return null;
  }

  const op: 'move' | 'copy' = modifiers.ctrl ? 'copy' : 'move';

  return { op, dest };
}

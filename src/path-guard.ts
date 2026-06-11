import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Path-confinement for the write-file IPC (I2). The renderer must NOT be able to
 * write arbitrary paths: every requested write is validated against the set of
 * legitimate workspace roots (open repos + session project folders). A request is
 * only allowed when the resolved target stays INSIDE one of those roots.
 *
 * This module is PURE/host-side and unit-tested in isolation — it is the backbone
 * of the security claim, so the containment rules live here, not inline in the IPC
 * handler. The handler just supplies the roots and the bytes.
 */

export type WriteResult = { ok: true; path: string } | { ok: false; error: string };

/** Normalize a directory root for prefix comparison: resolve + trailing separator. */
function normRoot(root: string): string {
  const resolved = path.resolve(root);
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
}

/**
 * True when `child` is the same as, or nested under, `root`. Compares resolved
 * absolute paths with a trailing-separator guard so `/work` does NOT match a
 * sibling `/work-evil`. Case-insensitive on win32 (the filesystem is), exact
 * elsewhere — matching how the OS itself resolves the two paths.
 */
export function isInsideRoot(child: string, root: string): boolean {
  const r = normRoot(root);
  const c = path.resolve(child);
  // The root dir itself is not a writable file target, but a path equal to the
  // root (sans separator) is contained; callers reject dirs separately.
  const cWithSep = c.endsWith(path.sep) ? c : c + path.sep;
  if (process.platform === 'win32') {
    return cWithSep.toLowerCase().startsWith(r.toLowerCase());
  }
  return cWithSep.startsWith(r);
}

/** True when the resolved target is contained by ANY of the given roots. */
export function isInsideAnyRoot(child: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInsideRoot(child, root));
}

/**
 * Resolve the real (symlink-followed) path of a target for re-checking containment.
 * If the file does not yet exist (a legitimate first save can't happen here — the
 * editor only writes files it opened — but be defensive), resolve the nearest
 * existing ancestor's real path and re-append the remaining segments, so a symlinked
 * PARENT directory can't be used to escape the root either.
 */
export function realPathLeaf(target: string): string {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // Target itself missing: walk up to the nearest existing ancestor, realpath
    // that, then re-join the not-yet-existing tail. This still catches a symlinked
    // existing parent that points outside the root.
    let dir = path.dirname(abs);
    const tail: string[] = [path.basename(abs)];
    // Guard against an infinite loop at the filesystem root.
    while (dir !== path.dirname(dir)) {
      try {
        const realDir = fs.realpathSync.native(dir);
        return path.join(realDir, ...tail.reverse());
      } catch {
        tail.push(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
    return abs;
  }
}

/**
 * Validate a write request against the workspace roots. Returns the canonical
 * absolute path to write on success, or a rejection with a human-readable reason.
 *
 * Rejection cases (all reported, never silently swallowed):
 *  - No workspace roots open at all.
 *  - The lexically-resolved target escapes every root (covers `..` traversal and
 *    absolute paths outside any root).
 *  - The symlink-resolved REAL path escapes every root (covers symlink traversal:
 *    a file or parent dir inside the root that links to somewhere outside it).
 *  - The resolved target is an existing directory (never overwrite a dir as a file).
 *
 * The two-stage check (lexical first, then real-path) mirrors a defence-in-depth
 * posture: the lexical check rejects the obvious `..`/absolute escapes cheaply, and
 * the real-path check closes the symlink hole even for paths that look contained.
 */
export function validateWrite(target: string, roots: readonly string[]): WriteResult {
  if (!target || typeof target !== 'string') {
    return { ok: false, error: 'No file path provided.' };
  }
  if (roots.length === 0) {
    return { ok: false, error: 'No open workspace to write into.' };
  }
  const abs = path.resolve(target);
  // Stage 1 — lexical containment (rejects `..` escapes and absolute-outside paths).
  if (!isInsideAnyRoot(abs, roots)) {
    return { ok: false, error: `Refusing to write outside the workspace: ${target}` };
  }
  // Stage 2 — real-path containment (rejects symlink traversal).
  const real = realPathLeaf(abs);
  if (!isInsideAnyRoot(real, roots)) {
    return { ok: false, error: `Refusing to write outside the workspace (symlink): ${target}` };
  }
  // Never clobber a directory.
  try {
    if (fs.statSync(real).isDirectory()) {
      return { ok: false, error: `Refusing to write over a directory: ${target}` };
    }
  } catch {
    /* missing target — fine; the atomic write creates it within the root */
  }
  return { ok: true, path: real };
}

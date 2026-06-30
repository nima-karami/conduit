import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInsideAnyRoot, realPathLeaf } from './path-guard';

/**
 * Import (copy) files/folders from OUTSIDE the workspace into a folder inside it —
 * the OS drag-and-drop case (dragging from Explorer/Finder onto the Files tree).
 *
 * Unlike fs-dnd (move/copy WITHIN the workspace, where BOTH ends are guarded), here the
 * sources are arbitrary OS paths the user explicitly dragged in, so only the TARGET dir is
 * path-guard validated. Always a COPY (never moves/deletes the user's original). Name
 * collisions get a non-clobbering "(n)" suffix instead of failing the whole drop.
 */

export type ImportResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: string; code?: 'EEXIST' };

/** Conflict policy mirroring fs-dnd (shared shape; see spec §3). */
export type ImportConflictPolicy = 'error' | 'replace' | 'rename';

/**
 * Resolve a non-colliding destination path for `name` inside `dir`. If it's free, returns
 * it as-is; otherwise appends " (1)", " (2)", … before the extension (mirroring how OS file
 * managers de-dupe). `exists` is injected so the chooser is pure and unit-testable.
 */
export function uniqueDestPath(
  dir: string,
  name: string,
  exists: (candidate: string) => boolean,
): string {
  const first = path.join(dir, name);
  if (!exists(first)) return first;
  // Split extension off the END only (a leading-dot dotfile like ".env" has no extension).
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
}

/**
 * Copy each of `sources` (OS paths) into `targetDir`. `targetDir` must be inside a known
 * workspace root (two-stage lexical + symlink-resolved check). Returns the destination
 * paths created, or the first error encountered.
 */
export async function fsImport(
  sources: readonly string[],
  targetDir: string,
  roots: readonly string[],
  opts: { onConflict?: ImportConflictPolicy } = {},
): Promise<ImportResult> {
  if (sources.length === 0) return { ok: false, error: 'Nothing to import.' };
  if (roots.length === 0) return { ok: false, error: 'No open workspace to import into.' };

  const absTarget = path.resolve(targetDir);
  if (!isInsideAnyRoot(absTarget, roots) || !isInsideAnyRoot(realPathLeaf(absTarget), roots)) {
    return { ok: false, error: `Refusing to import outside the workspace: ${targetDir}` };
  }

  // Default 'rename' keeps the original non-clobbering "(n)" behavior (back-compat); the
  // renderer drives one source at a time with an explicit policy when the dialog is in play.
  const policy = opts.onConflict ?? 'rename';

  try {
    await fs.promises.mkdir(absTarget, { recursive: true });
    const created: string[] = [];
    for (const src of sources) {
      if (!src) continue;
      const absSrc = path.resolve(src);
      let dest = path.join(absTarget, path.basename(absSrc));
      if (fs.existsSync(dest)) {
        if (policy === 'error')
          return { ok: false, code: 'EEXIST', error: `Already exists: ${dest}` };
        if (policy === 'rename') {
          dest = uniqueDestPath(absTarget, path.basename(absSrc), (p) => fs.existsSync(p));
        } else {
          await fs.promises.rm(dest, { recursive: true, force: true });
        }
      }
      await fs.promises.cp(absSrc, dest, { recursive: true });
      created.push(dest);
    }
    if (created.length === 0) return { ok: false, error: 'Nothing to import.' };
    return { ok: true, paths: created };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

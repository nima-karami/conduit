import * as fs from 'node:fs';
import * as path from 'node:path';
import { IGNORED } from './content-search';
import type { IndexedFile } from './path-resolve';
import type { SearchHit } from './protocol';

/**
 * Directory names never descended into during file search. Re-exported from
 * src/content-search (the single source of truth) so the name-search walk and the
 * content-search walk share ONE ignore set rather than drifting copies.
 */
export const SEARCH_IGNORE = IGNORED;

const DEFAULT_CAP = 4000;

/**
 * Recursively list files under `root` (breadth-first), skipping `ignore`d directories (default
 * {@link SEARCH_IGNORE}), capped at `cap` entries. Returns hits with forward-slash rel paths.
 * Pure walk — filtering/ranking by query happens in the renderer (fuzzy).
 *
 * `ignore` is a parameter because the default set is tuned for searching a PROJECT, where
 * `dist`/`build`/`out` are generated noise. Walking a published PACKAGE is the opposite case —
 * that is exactly where its declarations ship. See `src/module-resolver-fs.ts`.
 */
export function walkFiles(
  root: string,
  cap = DEFAULT_CAP,
  readdir: (p: string) => fs.Dirent[] = (p) => fs.readdirSync(p, { withFileTypes: true }),
  ignore: ReadonlySet<string> = SEARCH_IGNORE,
): SearchHit[] {
  const walk = fileWalk(root, cap, ignore);
  let step = walk.next();
  while (!step.done) {
    let entries: fs.Dirent[];
    try {
      entries = readdir(step.value);
    } catch {
      entries = [];
    }
    step = walk.next(entries);
  }
  return step.value;
}

export async function walkFilesAsync(root: string, cap = DEFAULT_CAP): Promise<SearchHit[]> {
  const walk = fileWalk(root, cap, SEARCH_IGNORE);
  let step = walk.next();
  while (!step.done) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(step.value, { withFileTypes: true });
    } catch {
      entries = [];
    }
    step = walk.next(entries);
  }
  return step.value;
}

function* fileWalk(
  root: string,
  cap: number,
  ignore: ReadonlySet<string>,
): Generator<string, SearchHit[], fs.Dirent[]> {
  const hits: SearchHit[] = [];
  const queue: string[] = [root];
  for (let next = 0; next < queue.length && hits.length < cap; next++) {
    const dir = queue[next];
    if (dir === undefined) break;
    const entries = yield dir;
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!ignore.has(e.name) && !e.name.startsWith('.git')) queue.push(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        hits.push({ rel, abs });
        if (hits.length >= cap) break;
      }
    }
  }
  return hits;
}

/**
 * Adapt project-index entries (gitignore-respecting, uncapped) to search hits. The index
 * stores `abs` with forward slashes; reveal-in-tree string-matches against native tree
 * paths, so `abs` is rebuilt with OS-native separators (matching {@link walkFiles}) while
 * `rel` stays forward-slash.
 */
export function indexToSearchHits(files: readonly IndexedFile[], root: string): SearchHit[] {
  return files.map((f) => ({ rel: f.rel, abs: path.join(root, f.rel) }));
}

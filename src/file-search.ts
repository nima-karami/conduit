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
 * Recursively list files under `root` (breadth-first), skipping {@link SEARCH_IGNORE}
 * directories, capped at `cap` entries. Returns hits with forward-slash rel paths.
 * Pure walk — filtering/ranking by query happens in the renderer (fuzzy).
 */
export function walkFiles(
  root: string,
  cap = DEFAULT_CAP,
  readdir: (p: string) => fs.Dirent[] = (p) => fs.readdirSync(p, { withFileTypes: true }),
): SearchHit[] {
  const hits: SearchHit[] = [];
  const queue: string[] = [root];
  while (queue.length && hits.length < cap) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_IGNORE.has(e.name) && !e.name.startsWith('.git')) queue.push(abs);
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

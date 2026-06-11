import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SearchHit } from './protocol';

/** Directory names never descended into during file search. */
export const SEARCH_IGNORE = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '.cache',
  '.next',
  'build',
  '.cursor',
  '.vscode-test',
  '.playwright',
  '.playwright-cli',
  '.playwright-mcp',
]);

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

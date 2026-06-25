import * as fs from 'node:fs';
import * as path from 'node:path';
import { IGNORED_DIRS } from './ignore-dirs';

export interface RepoInfo {
  /** Absolute repo root, forward-slashed. */
  root: string;
  /** Repo root relative to the opened root ('.' when the opened root IS the repo). */
  name: string;
}

const MAX_REPO_SCAN_DEPTH = 4;
const REPO_SCAN_CAP = 200;

const slash = (p: string): string => p.replace(/\\/g, '/');

/** A `.git` dir OR file marks a repo (the file form covers submodules / linked worktrees). */
function isRepoRoot(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded recursive scan under `openedRoot` for git repos. Stops descending once a repo is
 * found (a repo's own subtree is not re-scanned). Skips heavy/uninteresting dirs, guards
 * symlink cycles by tracking visited real paths, caps the result, and never throws.
 */
export async function detectRepos(
  openedRoot: string,
  opts: { maxDepth?: number; cap?: number } = {},
): Promise<RepoInfo[]> {
  const maxDepth = opts.maxDepth ?? MAX_REPO_SCAN_DEPTH;
  const cap = opts.cap ?? REPO_SCAN_CAP;

  const out: RepoInfo[] = [];
  const seen = new Set<string>();

  const nameFor = (repoRoot: string): string => {
    const rel = slash(path.relative(openedRoot, repoRoot));
    return rel === '' ? '.' : rel;
  };

  const walk = (dir: string, depth: number) => {
    if (out.length >= cap) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return; // symlink-cycle guard
    seen.add(real);

    if (isRepoRoot(dir)) {
      const abs = path.resolve(dir);
      out.push({ root: slash(abs), name: nameFor(abs) });
      return; // do not descend into a found repo
    }
    if (depth >= maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (!e.isDirectory() || IGNORED_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  walk(openedRoot, 0);
  return out;
}

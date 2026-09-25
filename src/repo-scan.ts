import * as fs from 'node:fs';
import * as path from 'node:path';
import { folderKey } from './folder-key';
import { IGNORED_DIRS } from './ignore-dirs';
import type { Session } from './types';

export interface DetectedRepo {
  /** Absolute repo root, forward-slashed. */
  root: string;
  /** Repo root relative to the opened root ('.' when the opened root IS the repo). */
  name: string;
}

export type RepoTag = 'home' | 'nested' | 'attached';

export interface RepoInfo extends DetectedRepo {
  folder: string;
  tag: RepoTag;
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
): Promise<DetectedRepo[]> {
  const maxDepth = opts.maxDepth ?? MAX_REPO_SCAN_DEPTH;
  const cap = opts.cap ?? REPO_SCAN_CAP;

  const out: DetectedRepo[] = [];
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

export async function scanSessionRepos(
  s: Pick<Session, 'home' | 'homeMissing' | 'roots' | 'missingRoots'>,
  deps: {
    detect: (folder: string) => Promise<DetectedRepo[]>;
    enclosing: (folder: string) => Promise<string>;
  },
): Promise<RepoInfo[]> {
  const homeKey = folderKey(s.home);
  const missing = new Set((s.missingRoots ?? []).map(folderKey));
  const folders = [
    ...(s.homeMissing ? [] : [s.home]),
    ...s.roots.filter((r) => !missing.has(folderKey(r))),
  ];
  const out: RepoInfo[] = [];
  const seen = new Set<string>();
  const add = (r: RepoInfo) => {
    const k = folderKey(r.root);
    if (seen.has(k) || out.length >= REPO_SCAN_CAP) return;
    seen.add(k);
    out.push(r);
  };
  for (const folder of folders) {
    const own = folderKey(folder);
    const isHome = own === homeKey;
    const down = await deps.detect(folder);
    if (!down.some((r) => folderKey(r.root) === own)) {
      const top = slash(await deps.enclosing(folder).catch(() => ''));
      if (top !== '' && folderKey(top) !== own) {
        add({
          root: top,
          name: top.split('/').filter(Boolean).pop() ?? top,
          folder,
          tag: isHome ? 'home' : 'attached',
        });
      }
    }
    for (const r of down) {
      const tag: RepoTag = !isHome ? 'attached' : folderKey(r.root) === homeKey ? 'home' : 'nested';
      add({ ...r, folder, tag });
    }
  }
  return out;
}

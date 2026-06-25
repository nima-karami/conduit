import type { RepoInfo } from './repo-scan';

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

function isAncestorOf(root: string, child: string): boolean {
  if (root === child) return true;
  return child.startsWith(`${root}/`);
}

/** Longest segment-aware prefix repo root containing `absPath`, else undefined. */
export function repoForPath(repos: RepoInfo[], absPath: string): string | undefined {
  const p = norm(absPath);
  let best: string | undefined;
  let bestLen = -1;
  for (const r of repos) {
    const root = norm(r.root);
    if (!isAncestorOf(root, p)) continue;
    if (root.length > bestLen) {
      bestLen = root.length;
      best = r.root;
    }
  }
  return best;
}

const exists = (repos: RepoInfo[], root: string | undefined): root is string =>
  !!root && repos.some((r) => norm(r.root) === norm(root));

/** pinned (if still present) → auto (if still present) → opened-root repo → first repo → none. */
export function resolveActiveRepo(input: {
  repos: RepoInfo[];
  pinnedRoot?: string;
  autoRoot?: string;
  openedRoot: string;
}): string | undefined {
  const { repos, pinnedRoot, autoRoot, openedRoot } = input;
  if (repos.length === 0) return undefined;
  if (exists(repos, pinnedRoot)) return pinnedRoot;
  if (exists(repos, autoRoot)) return autoRoot;
  const rootRepo = repos.find((r) => norm(r.root) === norm(openedRoot));
  return rootRepo ? rootRepo.root : repos[0].root;
}

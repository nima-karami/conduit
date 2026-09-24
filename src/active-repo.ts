import { gitRootForSession } from './active-cwd';
import { folderKey } from './folder-key';
import { isAncestorOf, normalizePath as norm } from './owning-session';
import type { RepoInfo } from './repo-scan';
import type { Session } from './types';

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

export function requestGitRoot(
  s: Pick<Session, 'repos' | 'activeRepoRoot' | 'cwd' | 'home'>,
  repoRoot: unknown,
): string | null {
  if (repoRoot === undefined) return gitRootForSession(s);
  if (typeof repoRoot !== 'string') return null;
  const key = folderKey(repoRoot);
  return s.repos?.find((r) => folderKey(r.root) === key)?.root ?? null;
}

/** The terminal link rule: the live-cwd repo is accepted even when it is not a detected repo
 *  (docs/specs/2026-09-23-mf-review.md §2.1 D11). `liveRepo` runs git, so only on a miss. */
export async function resolveRequestRepoRoot(
  s: Pick<Session, 'repos' | 'activeRepoRoot' | 'cwd' | 'home'>,
  repoRoot: unknown,
  liveRepo: () => Promise<string>,
): Promise<string | null> {
  const detected = requestGitRoot(s, repoRoot);
  if (detected !== null || typeof repoRoot !== 'string' || repoRoot === '') return detected;
  const live = await liveRepo();
  return live !== '' && folderKey(live) === folderKey(repoRoot) ? repoRoot : null;
}

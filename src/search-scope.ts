import { folderKey } from './folder-key';
import { isAncestorOf } from './owning-session';
import type { IndexScope } from './protocol';
import type { Session } from './types';

// Content-search scope in a folder of repos: docs/specs/2026-10-16-multi-repo-tracking.md §2
// (Search), §8 (Search scope chip); rules in the plan's Contracts (Search, Slices 3–4).

export type SearchScope = 'tracked' | 'repo' | 'everything';

/** Present folders under no repo: the ones where the scope chooses between index kinds. Empty
 *  until the first repo scan, so a git folder never flashes the chip, and empty while the
 *  session has no repo at all: with nothing to scope, search stays exactly as before. */
export function scopeChipFolders(
  session: Pick<Session, 'home' | 'roots' | 'repos' | 'missingRoots' | 'homeMissing'>,
): string[] {
  const { repos } = session;
  if (repos === undefined || repos.length === 0) return [];
  const missing = new Set((session.missingRoots ?? []).map(folderKey));
  const present = [
    ...(session.homeMissing ? [] : [session.home]),
    ...session.roots.filter((r) => !missing.has(folderKey(r))),
  ];
  const repoKeys = repos.map((r) => folderKey(r.root));
  return present.filter((f) => {
    const key = folderKey(f);
    return !repoKeys.some((r) => isAncestorOf(r, key));
  });
}

export function searchTargets(
  folders: readonly string[],
  scope: SearchScope,
  activeRepoRoot: string | undefined,
  chipFolders: readonly string[],
): Array<{ root: string; scope: IndexScope }> {
  if (scope === 'repo') return activeRepoRoot ? [{ root: activeRepoRoot, scope: 'tracked' }] : [];
  const chip = new Set(chipFolders.map(folderKey));
  return folders.map((root) => ({
    root,
    scope: scope === 'everything' && chip.has(folderKey(root)) ? 'everything' : 'tracked',
  }));
}

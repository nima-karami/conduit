import { folderKey } from './folder-key';
import type { RepoInfo } from './repo-scan';

/** home → nested (by root) → attached grouped by folder in `roots` order, by root within a
 *  folder; an attached repo whose folder matches no root sorts last by root. Pure, copies. */
export function orderRepos(repos: readonly RepoInfo[], roots: readonly string[]): RepoInfo[] {
  const rootKeys = roots.map(folderKey);
  const rank = (r: RepoInfo): number => {
    if (r.tag === 'home') return 0;
    if (r.tag === 'nested') return 1;
    const i = rootKeys.indexOf(folderKey(r.folder));
    return 2 + (i === -1 ? rootKeys.length : i);
  };
  return [...repos].sort((a, b) => rank(a) - rank(b) || a.root.localeCompare(b.root));
}

/** Order-insensitive identity of a repo set; '' for []. */
export function repoSetKey(repos: readonly { root: string }[]): string {
  return repos
    .map((r) => folderKey(r.root))
    .sort()
    .join('\n');
}

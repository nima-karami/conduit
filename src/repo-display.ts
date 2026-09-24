import { folderKey } from './folder-key';
import { normalizePath } from './owning-session';
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

export function repoBaseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** `${repoBaseName(folder)}/${rel}` when root sits below folder (by folderKey), else undefined. */
export function repoSub(repo: Pick<RepoInfo, 'root' | 'folder'>): string | undefined {
  const folder = folderKey(repo.folder);
  if (!folderKey(repo.root).startsWith(`${folder}/`)) return undefined;
  const rel = normalizePath(repo.root).slice(folder.length + 1);
  return `${repoBaseName(repo.folder)}/${rel}`;
}

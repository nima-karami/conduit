import { folderKey } from './folder-key';
import { mapWithConcurrency } from './git-exec';
import { isAncestorOf } from './owning-session';
import type { IndexedFile } from './path-resolve';
import type { SearchHit } from './protocol';

// The file index of a non-git root: each repo's `git ls-files` plus the loose files outside
// every repo. See docs/specs/2026-10-16-multi-repo-tracking.md §2 (Search) and the plan's
// Contracts (Search, Slices 3–4).

export const LOOSE_FILE_CAP = 20000;
const LIST_CONCURRENCY = 4;

export interface RepoFileIndexDeps {
  /** gitListedFiles: repo-relative, forward-slash; [] when git gave nothing. */
  listRepo(root: string): Promise<string[]>;
  /** walkFilesAsync */
  walkLoose(root: string, prune: (absDir: string) => boolean, cap: number): Promise<SearchHit[]>;
}

export interface RepoFileIndex {
  /** Union of each repo's listing (re-listed only after invalidateRepo) + loose files outside
   *  repos (re-walked only after invalidateLoose, or when the repo set under root changes).
   *  Forward-slash rel (root-relative) and abs. */
  build(root: string, repos: readonly { key: string; root: string }[]): Promise<IndexedFile[]>;
  invalidateRepo(key: string): void;
  /** Every root's loose part. */
  invalidateLoose(): void;
}

const toSlash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

export function createRepoFileIndex(deps: RepoFileIndexDeps): RepoFileIndex {
  const listings = new Map<string, { version: number; rels: string[] }>();
  const repoVersions = new Map<string, number>();
  let looseVersion = 0;
  const loose = new Map<string, { version: number; repoSet: string; files: IndexedFile[] }>();
  /** Repo keys each root's last build used: a listing no root uses any more is dropped. */
  const usedBy = new Map<string, ReadonlySet<string>>();

  // The version is read before the await, so an invalidation that lands mid-listing leaves the
  // stored entry already out of date and the next build lists again.
  const listingOf = async (repo: { key: string; root: string }): Promise<string[]> => {
    const version = repoVersions.get(repo.key) ?? 0;
    const cached = listings.get(repo.key);
    if (cached && cached.version === version) return cached.rels;
    const rels = await deps.listRepo(repo.root);
    // An empty answer is also what a timed-out git gives; never pin it.
    if (rels.length > 0) listings.set(repo.key, { version, rels });
    return rels;
  };

  const looseOf = async (
    root: string,
    rootKey: string,
    repoKeys: readonly string[],
  ): Promise<IndexedFile[]> => {
    const version = looseVersion;
    const repoSet = repoKeys.join('\n');
    const cached = loose.get(rootKey);
    if (cached && cached.version === version && cached.repoSet === repoSet) return cached.files;
    const prunable = new Set(repoKeys);
    const hits = await deps.walkLoose(root, (abs) => prunable.has(folderKey(abs)), LOOSE_FILE_CAP);
    const files = hits.map((h) => ({ rel: h.rel, abs: toSlash(h.abs) }));
    loose.set(rootKey, { version, repoSet, files });
    return files;
  };

  const evictUnused = () => {
    const used = new Set<string>();
    for (const keys of usedBy.values()) for (const k of keys) used.add(k);
    for (const key of listings.keys()) if (!used.has(key)) listings.delete(key);
  };

  return {
    async build(root, repos) {
      const rootSlash = toSlash(root);
      const rootKey = folderKey(root);
      const under = repos.filter((r) => isAncestorOf(rootKey, r.key));
      usedBy.set(rootKey, new Set(under.map((r) => r.key)));
      evictUnused();
      const rootIsRepo = under.some((r) => r.key === rootKey);
      const [listed, looseFiles] = await Promise.all([
        mapWithConcurrency(under, LIST_CONCURRENCY, listingOf),
        rootIsRepo
          ? Promise.resolve([])
          : looseOf(
              root,
              rootKey,
              under.map((r) => r.key),
            ),
      ]);
      const byRel = new Map<string, IndexedFile>();
      under.forEach((repo, i) => {
        const repoSlash = toSlash(repo.root);
        const prefix = repo.key === rootKey ? '' : `${repoSlash.slice(rootSlash.length + 1)}/`;
        for (const rel of listed[i])
          byRel.set(`${prefix}${rel}`, { rel: `${prefix}${rel}`, abs: `${repoSlash}/${rel}` });
      });
      for (const f of looseFiles) if (!byRel.has(f.rel)) byRel.set(f.rel, f);
      return [...byRel.values()];
    },
    invalidateRepo(key) {
      repoVersions.set(key, (repoVersions.get(key) ?? 0) + 1);
    },
    invalidateLoose() {
      looseVersion += 1;
    },
  };
}

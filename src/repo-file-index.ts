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
  /** gitListedFiles' rels (repo-relative, forward-slash); null when git did not answer, which
   *  is never an empty repo; 'not-repo' when git answered that the folder is in no repo (a
   *  registered repo whose .git went away), which is walked without degrading the build. */
  listRepo(root: string): Promise<string[] | 'not-repo' | null>;
  /** walkFilesAsync */
  walkLoose(root: string, prune: (absDir: string) => boolean, cap: number): Promise<SearchHit[]>;
}

export interface RepoFileIndexBuild {
  /** Forward-slash rel (root-relative) and abs. */
  files: IndexedFile[];
  /** Forward-slashed roots of the repos whose files came from their own listing in this build:
   *  not walked, not a stale last-good listing (plan 2026-10-16-terminal-path-links T3.4). */
  coveredRepos: string[];
}

export interface RepoFileIndex {
  /** Union of each repo's listing (re-listed only after invalidateRepo) + loose files outside
   *  repos (re-walked only after invalidateLoose, or when the repo set under root changes). */
  build(root: string, repos: readonly { key: string; root: string }[]): Promise<RepoFileIndexBuild>;
  invalidateRepo(key: string): void;
  /** Every root's loose part. */
  invalidateLoose(): void;
  /** Forget every root and repo outside these folderKey'd sets (a closed session or folder, an
   *  unregistered repo). */
  retain(rootKeys: ReadonlySet<string>, repoKeys: ReadonlySet<string>): void;
}

const toSlash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** `serial` names one stored listing or walk, so a union built from the same ones is reused. */
interface Listing {
  rels: string[];
  serial: number;
  /** False: git did not answer this time and these are the last good rels. */
  fresh: boolean;
}

export function createRepoFileIndex(deps: RepoFileIndexDeps): RepoFileIndex {
  let serial = 0;
  const listings = new Map<string, { version: number; rels: string[]; serial: number }>();
  const inflight = new Map<
    string,
    { version: number; promise: Promise<Listing | 'not-repo' | null> }
  >();
  const repoVersions = new Map<string, number>();
  let looseVersion = 0;
  const loose = new Map<
    string,
    { version: number; repoSet: string; files: IndexedFile[]; serial: number }
  >();
  const unions = new Map<string, { sig: string; files: IndexedFile[]; coveredRepos: string[] }>();
  /** Repo keys each root's last build used: a listing no root uses any more is dropped. */
  const usedBy = new Map<string, ReadonlySet<string>>();

  // The version is read before the await, so an invalidation that lands mid-listing leaves the
  // stored entry already out of date and the next build lists again. Builds asking for the same
  // repo at the same version share one `ls-files`.
  const listingOf = (repo: { key: string; root: string }): Promise<Listing | 'not-repo' | null> => {
    const version = repoVersions.get(repo.key) ?? 0;
    const cached = listings.get(repo.key);
    if (cached?.version === version)
      return Promise.resolve({ rels: cached.rels, serial: cached.serial, fresh: true });
    const pending = inflight.get(repo.key);
    if (pending?.version === version) return pending.promise;
    const promise: Promise<Listing | 'not-repo' | null> = (async () => {
      const rels = await deps.listRepo(repo.root);
      if (inflight.get(repo.key)?.version === version) inflight.delete(repo.key);
      if (rels === 'not-repo') return rels;
      if (rels !== null) {
        const entry = { version, rels, serial: ++serial };
        if ((listings.get(repo.key)?.version ?? -1) <= version) listings.set(repo.key, entry);
        return { rels, serial: entry.serial, fresh: true };
      }
      // Its stored version stays behind, so the next build asks git again.
      const last = listings.get(repo.key);
      return last ? { rels: last.rels, serial: last.serial, fresh: false } : null;
    })();
    inflight.set(repo.key, { version, promise });
    return promise;
  };

  const looseOf = async (
    root: string,
    rootKey: string,
    repoKeys: readonly string[],
  ): Promise<{ files: IndexedFile[]; serial: number }> => {
    const version = looseVersion;
    const repoSet = repoKeys.join('\n');
    const cached = loose.get(rootKey);
    if (cached && cached.version === version && cached.repoSet === repoSet) return cached;
    const prunable = new Set(repoKeys);
    const hits = await deps.walkLoose(root, (abs) => prunable.has(folderKey(abs)), LOOSE_FILE_CAP);
    const entry = {
      version,
      repoSet,
      files: hits.map((h) => ({ rel: h.rel, abs: toSlash(h.abs) })),
      serial: ++serial,
    };
    loose.set(rootKey, entry);
    return entry;
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
          ? Promise.resolve(null)
          : looseOf(
              root,
              rootKey,
              under.map((r) => r.key),
            ),
      ]);
      const lists = listed.map((l) => (l === 'not-repo' ? null : l));
      const degraded = listed.some((l) => l === null || (l !== 'not-repo' && !l.fresh));
      const parts = under.map((r, i) => `${r.key}@${lists[i]?.serial}`);
      // A walked repo has no serial to tell a changed walk from the last one, so no memo.
      const sig =
        degraded || lists.includes(null)
          ? null
          : `${parts.join('\n')}\n#${looseFiles?.serial ?? ''}`;
      const memo = unions.get(rootKey);
      if (sig !== null && memo?.sig === sig)
        return { files: memo.files, coveredRepos: memo.coveredRepos };
      const coveredRepos = under
        .filter((_, i) => lists[i]?.fresh === true)
        .map((r) => toSlash(r.root));

      // A repo git never listed is walked instead (the loose walk pruned it), skipping the
      // listed repos inside it.
      const listedKeys = new Set(under.filter((_, i) => lists[i] !== null).map((r) => r.key));
      const walked = await Promise.all(
        under.map((repo, i) =>
          lists[i] === null
            ? deps.walkLoose(repo.root, (abs) => listedKeys.has(folderKey(abs)), LOOSE_FILE_CAP)
            : Promise.resolve(null),
        ),
      );
      const byRel = new Map<string, IndexedFile>();
      under.forEach((repo, i) => {
        const repoSlash = toSlash(repo.root);
        const prefix = repo.key === rootKey ? '' : `${repoSlash.slice(rootSlash.length + 1)}/`;
        const rels = lists[i]?.rels ?? walked[i]?.map((h) => h.rel) ?? [];
        for (const rel of rels)
          byRel.set(`${prefix}${rel}`, { rel: `${prefix}${rel}`, abs: `${repoSlash}/${rel}` });
      });
      for (const f of looseFiles?.files ?? []) if (!byRel.has(f.rel)) byRel.set(f.rel, f);
      const files = [...byRel.values()];
      if (sig === null) unions.delete(rootKey);
      else unions.set(rootKey, { sig, files, coveredRepos });
      return { files, coveredRepos };
    },
    invalidateRepo(key) {
      repoVersions.set(key, (repoVersions.get(key) ?? 0) + 1);
    },
    invalidateLoose() {
      looseVersion += 1;
    },
    retain(rootKeys, repoKeys) {
      for (const map of [usedBy, loose, unions])
        for (const key of [...map.keys()]) if (!rootKeys.has(key)) map.delete(key);
      for (const map of [repoVersions, listings, inflight])
        for (const key of [...map.keys()]) if (!repoKeys.has(key)) map.delete(key);
      evictUnused();
    },
  };
}

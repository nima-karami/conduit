import { ExpiringCache } from './expiring-cache';
import { folderKey } from './folder-key';
import type { GitListing } from './git-listing';
import type { IndexedFile } from './path-resolve';
import type { IndexScope, SearchHit } from './protocol';
import { LOOSE_FILE_CAP, type RepoFileIndex } from './repo-file-index';

// The project file index behind quick open, find in files, path links and the TS source index.
// See docs/specs/2026-10-16-multi-repo-tracking.md §2 (Search) and the plan's Contracts.

export const FILE_INDEX_TTL_MS = 5000;

export interface ProjectFileIndexMeta {
  files: IndexedFile[];
  /** The capped walk hit its cap. */
  capped: boolean;
  /** The repos a non-git root's index was built from (repoSetOf), null otherwise, so the TS
   *  index can tell when it is out of date. */
  repoSet: string | null;
}

export interface ProjectFileIndexDeps {
  listGit(root: string): Promise<GitListing>;
  walk(root: string, cap: number): Promise<SearchHit[]>;
  repoIndex: Pick<RepoFileIndex, 'build'>;
  reposUnder(rootKey: string): readonly { key: string; root: string }[];
  /** A root's listing outgrew the buffer. Called once per root: it recurs on every build, and
   *  the walk it falls back to ignores .gitignore, so the search results change shape. */
  onTruncated?(root: string): void;
  clock?: () => number;
}

/** The repos a non-git root's index was built from, as a comparable string. */
export const repoSetOf = (repos: readonly { key: string }[]) => repos.map((r) => r.key).join('\n');

export type ProjectFileIndexFn = (
  root: string,
  opts?: { fresh?: boolean; scope?: IndexScope },
) => Promise<ProjectFileIndexMeta>;

/** Build (or reuse, within the TTL) the project file index for `root`: `git ls-files` for a git
 *  root; for a non-git root, its registered repos' listings plus the loose files outside them
 *  (src/repo-file-index.ts); with scope 'everything', or when git did not list a git root, the
 *  capped walk that ignores .gitignore. */
export function createProjectFileIndex(deps: ProjectFileIndexDeps): ProjectFileIndexFn {
  const clock = deps.clock ?? Date.now;
  const cache = new ExpiringCache<string, ProjectFileIndexMeta & { at: number }>({
    ttlMs: FILE_INDEX_TTL_MS,
    maxEntries: 64,
    maxBytes: 32 * 1024 * 1024,
    sizeOf: (entry) =>
      entry.files.reduce((bytes, file) => bytes + (file.rel.length + file.abs.length) * 2 + 96, 0),
    clock,
  });
  const reportedTruncated = new Set<string>();
  const keep = (key: string, meta: ProjectFileIndexMeta): ProjectFileIndexMeta => {
    cache.set(key, { ...meta, at: clock() });
    return meta;
  };

  return async (root, opts = {}) => {
    const cacheKey = `${root}\0${opts.scope ?? 'tracked'}`;
    const cached = cache.get(cacheKey);
    // An incremental index is triggered BY a filesystem change, so serving it the TTL cache
    // would hand back exactly the pre-change listing it was called to notice. It still WRITES
    // the cache, so the refresh is shared with whatever asks next.
    if (!opts.fresh && cached && clock() - cached.at < FILE_INDEX_TTL_MS) return cached;
    const listing = await deps.listGit(root);
    if (listing.kind === 'listed') {
      const files = listing.rels.map((rel) => ({ rel, abs: `${root}/${rel}` }));
      return keep(cacheKey, { files, capped: false, repoSet: null });
    }
    if (listing.kind === 'truncated' && !reportedTruncated.has(root)) {
      reportedTruncated.add(root);
      deps.onTruncated?.(root);
    }
    if (listing.kind !== 'not-repo' || opts.scope === 'everything') {
      // The cap is generous because this walk used to back the TS source index too, and the
      // search-sized default truncated deep source directories out of it. A listing git could
      // not give is cached for the TTL like any other: a repeatable failure (a listing past the
      // buffer, a timeout on a huge tree) would otherwise re-spawn git and re-walk on every ask
      // (search-scope review r2 SF3).
      const files = (await deps.walk(root, LOOSE_FILE_CAP)).map((h) => ({
        rel: h.rel,
        abs: h.abs.replace(/\\/g, '/'),
      }));
      return keep(cacheKey, { files, capped: files.length >= LOOSE_FILE_CAP, repoSet: null });
    }
    const repos = deps.reposUnder(folderKey(root));
    const built = await deps.repoIndex.build(root, repos);
    return keep(cacheKey, { files: built.files, capped: false, repoSet: repoSetOf(repos) });
  };
}

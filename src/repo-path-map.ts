import { folderKey } from './folder-key';

// Event path → repo key + dirty kind. Rules and their order:
// docs/plans/2026-10-16-multi-repo-tracking.plan.md (Contracts, repo-path-map).

export type DirtyKind = 'tree' | 'meta';

export interface RepoPaths {
  /** folderKey(root) */
  key: string;
  /** As in RepoInfo.root. */
  root: string;
  /** folderKey'd; undefined until the first interrogation. */
  gitDir?: string;
  /** folderKey'd. */
  commonDir?: string;
  /** GitInfo.branch when kind === 'branch'. */
  branch?: string;
}

export interface PathHit {
  key: string;
  kind: DirtyKind;
}

export const META_FILES: ReadonlySet<string> = new Set([
  'HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'ORIG_HEAD',
  'rebase-merge',
  'rebase-apply',
]);

// folderKey lowercases a whole drive-letter path, so names inside a git dir are compared folded.
const META_FOLDED: ReadonlySet<string> = new Set([...META_FILES].map((f) => f.toLowerCase()));
const INDEX = 'index';

function* ancestorsOf(absKey: string): Generator<string> {
  let p = absKey;
  yield p;
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/')) {
    p = p.slice(0, i);
    yield p;
  }
}

export class RepoPathMap {
  private readonly byRoot = new Map<string, string>();
  private readonly byGitDir = new Map<string, string>();
  private readonly commonDirs = new Set<string>();
  /** `<commonDir>/refs/heads/<branch>` and `<commonDir>/packed-refs`, folderKey'd → repo keys. */
  private readonly refs = new Map<string, string[]>();
  /** `<commonDir>/reftable`, folderKey'd → repo keys: a reftable repo writes every ref update
   *  there, so no single branch file names the repo it moved. */
  private readonly reftables = new Map<string, string[]>();

  constructor(repos: readonly RepoPaths[]) {
    const add = (into: Map<string, string[]>, at: string, key: string) => {
      const keys = into.get(at);
      if (keys) keys.push(key);
      else into.set(at, [key]);
    };
    for (const r of repos) {
      this.byRoot.set(r.key, r.key);
      if (r.gitDir) this.byGitDir.set(r.gitDir, r.key);
      if (!r.commonDir) continue;
      this.commonDirs.add(r.commonDir);
      add(this.refs, folderKey(`${r.commonDir}/packed-refs`), r.key);
      add(this.reftables, folderKey(`${r.commonDir}/reftable`), r.key);
      if (r.branch !== undefined)
        add(this.refs, folderKey(`${r.commonDir}/refs/heads/${r.branch}`), r.key);
    }
  }

  /** absKey is folderKey'd. [] = loose path (under no repo, not git metadata). */
  classify(absKey: string): PathHit[] {
    const refKeys = this.refs.get(absKey);
    if (refKeys) return refKeys.map((key) => ({ key, kind: 'meta' }));
    for (const dir of ancestorsOf(absKey)) {
      const reftableKeys = this.reftables.get(dir);
      if (reftableKeys) return reftableKeys.map((key) => ({ key, kind: 'meta' }));
      const gitDirOwner = this.byGitDir.get(dir);
      if (gitDirOwner !== undefined) {
        if (dir === absKey) return [];
        const rel = absKey.slice(dir.length + 1).toLowerCase();
        if (rel === INDEX) return [{ key: gitDirOwner, kind: 'tree' }];
        if (META_FOLDED.has(rel.split('/')[0])) return [{ key: gitDirOwner, kind: 'meta' }];
        return [];
      }
      if (this.commonDirs.has(dir)) return [];
      const root = this.byRoot.get(dir);
      if (root !== undefined) return [{ key: root, kind: 'tree' }];
    }
    return [];
  }

  /** True when absKey is inside some repo's git dir (so a [] result is NOT a loose file). */
  isGitMetadata(absKey: string): boolean {
    for (const dir of ancestorsOf(absKey)) {
      if (this.byGitDir.has(dir) || this.commonDirs.has(dir)) return true;
    }
    return false;
  }
}

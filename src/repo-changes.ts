import { folderKey } from './folder-key';
import { mapWithConcurrency } from './git-exec';
import type { ChangeDTO, RepoChanges } from './protocol';
import { repoBaseName, repoSub } from './repo-display';
import type { RepoInfo } from './repo-scan';

/** `repos` must already be in display order; see docs/specs/2026-09-23-mf-changes.md §3 "Host fan-out". */
export async function buildRepoChanges(input: {
  repos: readonly RepoInfo[];
  activeRoot: string | undefined;
  activeChanges: ChangeDTO[];
  changesFor: (root: string) => Promise<ChangeDTO[]>;
  limit?: number;
}): Promise<RepoChanges[]> {
  const activeKey = input.activeRoot === undefined ? undefined : folderKey(input.activeRoot);
  return mapWithConcurrency([...input.repos], input.limit ?? 4, async (repo) => {
    const out: RepoChanges = {
      root: repo.root,
      name: repoBaseName(repo.root),
      tag: repo.tag,
      changes: [],
    };
    const sub = repoSub(repo);
    if (sub !== undefined) out.sub = sub;
    if (folderKey(repo.root) === activeKey) {
      out.changes = input.activeChanges;
    } else {
      try {
        out.changes = await input.changesFor(repo.root);
      } catch (err) {
        console.error(`[git] changes failed for ${repo.root}:`, err);
      }
    }
    return out;
  });
}

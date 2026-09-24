import type { RepoChanges } from './protocol';
import { repoSetKey } from './repo-display';
import type { RepoInfo } from './repo-scan';

/** A reply computed for a repo set the session has since left is dropped, not shown. */
export function acceptRepoChanges(
  prev: RepoChanges[] | undefined,
  incoming: RepoChanges[] | undefined,
  repos: readonly RepoInfo[] | undefined,
): RepoChanges[] | undefined {
  if (incoming === undefined || repos === undefined) return prev;
  return repoSetKey(incoming) === repoSetKey(repos) ? incoming : prev;
}

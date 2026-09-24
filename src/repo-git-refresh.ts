import { mapWithConcurrency } from './git-exec';
import type { GitInterrogation } from './git-info';
import type { GitInfo } from './types';

export const HEAD_WATCH_CAP = 16;

export interface RepoInterrogation {
  root: string;
  info: GitInfo;
  headPath?: string;
}

/** A failed interrogation is kept as `{ kind: 'none' }`, see docs/specs/2026-09-23-mf-changes.md §2.3. */
export function interrogateRepos(
  roots: readonly string[],
  interrogate: (root: string) => Promise<GitInterrogation>,
  limit = 4,
): Promise<RepoInterrogation[]> {
  return mapWithConcurrency([...roots], limit, async (root): Promise<RepoInterrogation> => {
    try {
      const { info, headPath } = await interrogate(root);
      return headPath === undefined ? { root, info } : { root, info, headPath };
    } catch (err) {
      console.error(`[git] interrogation failed for ${root}:`, err);
      return { root, info: { kind: 'none' } };
    }
  });
}

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

export interface RefreshTarget {
  sessionId: string;
  roots: readonly string[];
}

export interface GitRefresher<T extends RefreshTarget> {
  refresh(targets: readonly T[]): Promise<void>;
  forget(sessionId: string): void;
}

/** Newest refresh per session wins: an older one that resolves later is dropped. */
export function createGitRefresher<T extends RefreshTarget>(deps: {
  interrogate: (root: string) => Promise<GitInterrogation>;
  apply: (target: T, results: RepoInterrogation[]) => void;
}): GitRefresher<T> {
  const generation = new Map<string, number>();
  let counter = 0;
  return {
    async refresh(targets) {
      const mine = ++counter;
      for (const t of targets) generation.set(t.sessionId, mine);
      await Promise.all(
        targets.map(async (t) => {
          const results = await interrogateRepos(t.roots, deps.interrogate);
          if (generation.get(t.sessionId) !== mine) return;
          deps.apply(t, results);
        }),
      );
    },
    forget(sessionId) {
      generation.delete(sessionId);
    },
  };
}

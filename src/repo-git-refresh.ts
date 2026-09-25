import { folderKey } from './folder-key';
import { mapWithConcurrency } from './git-exec';
import type { GitInterrogation } from './git-info';
import type { GitInfo } from './types';

export const HEAD_WATCH_CAP = 16;
export const GIT_INTERROGATION_LIMIT = 4;

export interface RepoInterrogation {
  root: string;
  info: GitInfo;
  headPath?: string;
}

/** A failed interrogation is kept as `{ kind: 'none' }`, see docs/specs/archive/2026-09-23-mf-changes.md §2.3. */
export function interrogateRepos(
  roots: readonly string[],
  interrogate: (root: string) => Promise<GitInterrogation>,
  limit = GIT_INTERROGATION_LIMIT,
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

function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Newest refresh per session wins: an older one that resolves later is dropped. Every refresh
 * shares one host-wide slot pool, and one call interrogates a repo several sessions share once.
 */
export function createGitRefresher<T extends RefreshTarget>(deps: {
  interrogate: (root: string) => Promise<GitInterrogation>;
  apply: (target: T, results: RepoInterrogation[]) => void;
}): GitRefresher<T> {
  const generation = new Map<string, number>();
  const limited = createLimiter(GIT_INTERROGATION_LIMIT);
  let counter = 0;
  return {
    async refresh(targets) {
      const mine = ++counter;
      for (const t of targets) generation.set(t.sessionId, mine);
      const unique = new Map<string, string>();
      for (const t of targets) {
        for (const root of t.roots)
          if (!unique.has(folderKey(root))) unique.set(folderKey(root), root);
      }
      const results = await interrogateRepos([...unique.values()], (root) =>
        limited(() => deps.interrogate(root)),
      );
      const byKey = new Map(results.map((r) => [folderKey(r.root), r]));
      for (const t of targets) {
        if (generation.get(t.sessionId) !== mine) continue;
        deps.apply(
          t,
          t.roots.flatMap((root) => {
            const r = byKey.get(folderKey(root));
            return r ? [{ ...r, root }] : [];
          }),
        );
      }
    },
    forget(sessionId) {
      generation.delete(sessionId);
    },
  };
}

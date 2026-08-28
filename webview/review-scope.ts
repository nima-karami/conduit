import type { DiffScope } from '../src/protocol';
import type { ReviewSource } from './docs';

/**
 * Review's working-source scope (spec 2026-08-27-review-supercharge §2 Lane D). `all` is the
 * whole working tree against HEAD — what Review has always shown — so it maps to `readDiff`'s
 * defaults and, so that the two never drift, to the UNSCOPED cache key.
 */
export type ReviewScope = 'all' | 'staged' | 'unstaged';

export const REVIEW_SCOPES: readonly ReviewScope[] = ['all', 'staged', 'unstaged'];

export const SCOPE_LABEL: Record<ReviewScope, string> = {
  all: 'All',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

/** A scope is only meaningful on the working source; commit/range reviews are always `all`. */
export function scopeOfSource(source: ReviewSource | undefined): ReviewScope {
  return source?.kind === 'working' ? (source.scope ?? 'all') : 'all';
}

export function scopeDiffArgs(scope: ReviewScope): DiffScope {
  if (scope === 'staged') return { base: 'head', side: 'index' };
  if (scope === 'unstaged') return { base: 'index', side: 'worktree' };
  return {};
}

export function scopeFromDiffArgs(args: DiffScope): ReviewScope {
  if (args.side === 'index') return 'staged';
  if (args.base === 'index') return 'unstaged';
  return 'all';
}

/** Cache key for one path's diff at one scope. `all` keeps the bare path so every existing
 *  consumer (the diff tab, the editor) reads the same entry it always did. */
export function diffKey(absPath: string, scope: ReviewScope): string {
  return scope === 'all' ? absPath : `${scope}\u0000${absPath}`;
}

/** The subset of a scoped cache that a Review at `scope` sees, re-keyed by plain path. */
export function diffsForScope<T>(diffs: Map<string, T>, scope: ReviewScope): Map<string, T> {
  if (scope === 'all') return diffs;
  const prefix = `${scope}\u0000`;
  const out = new Map<string, T>();
  for (const [k, v] of diffs) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
  return out;
}

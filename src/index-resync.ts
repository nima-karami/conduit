// The TS source index of a non-git root is built from the repos registered under it at that
// moment. One built before the first repo scan (or before a repo was added or removed) holds the
// wrong set: a repo's gitignored files came in through the loose walk, and a top-up only adds.
// See the plan's Contracts (Search, Slices 3–4) and search-scope review r1.

/** Roots whose index was built from a repo set (non-git roots) that is no longer the current
 *  one. A root indexed as a git root (`repoSet: null`) never goes stale this way. */
export function staleIndexRoots(
  indexed: Iterable<[root: string, state: { repoSet: string | null }]>,
  currentRepoSet: (root: string) => string,
): string[] {
  const out: string[] = [];
  for (const [root, state] of indexed) {
    if (state.repoSet !== null && state.repoSet !== currentRepoSet(root)) out.push(root);
  }
  return out;
}

/** What a re-sync takes out of the TS project: files the index sent before that it no longer
 *  selects. Files an on-demand module resolution sent (`resolved`) were never in the selection
 *  and stay. */
export function indexRemovals(
  sent: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
  selected: readonly string[],
): string[] {
  const keep = new Set(selected);
  return [...sent].filter((p) => !keep.has(p) && !resolved.has(p));
}

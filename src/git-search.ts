import type { CommitNode, GitRef, HistoryState } from './protocol';

/**
 * git-history Slice B — PURE, node-free search / filter / windowing helpers. Kept in `src/`
 * (not the renderer) so they unit-test without a DOM AND the renderer imports them without
 * pulling node. All client-side: the graph holds up to ~500 loaded commits, so filtering
 * the in-memory set is instant and far more responsive than a host round-trip per keystroke.
 */

/**
 * Case-insensitive substring match of `query` over a commit's searchable fields: the full
 * + short (7-char) sha, subject, body, author name, and email. Empty/whitespace query
 * matches everything (so an empty search box shows the full set). Pure.
 */
export function matchesQuery(commit: CommitNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    commit.sha,
    commit.sha.slice(0, 7),
    commit.subject,
    commit.body ?? '',
    commit.author,
    commit.email ?? '',
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

/**
 * PURE. Union of commit lists into one deduped, date-descending set. Used by BOTH the host
 * search (OR-merging its per-criterion `git log` runs) and the renderer (folding deep-history
 * search hits into the loaded page for display). First occurrence of a sha wins, so a caller
 * passing the fully-decorated loaded copy FIRST keeps its ref badges over a sparser search copy.
 * Sorted by author date desc (newest first), matching git's `--date-order`; equal dates keep
 * insertion order (V8 sort is stable). Input arrays are not mutated.
 */
export function dedupeAndSortCommits(commits: CommitNode[]): CommitNode[] {
  const bySha = new Map<string, CommitNode>();
  for (const commit of commits) {
    if (!bySha.has(commit.sha)) bySha.set(commit.sha, commit);
  }
  return [...bySha.values()].sort((a, b) => b.date - a.date);
}

/** True when the commit carries a ref whose human name equals `refName` (exact, case-
 *  sensitive — ref names are user data and git treats them case-sensitively). Pure. */
export function hasRef(commit: CommitNode, refName: string): boolean {
  return commit.refs.some((r) => r.name === refName);
}

/**
 * Distinct refs across the loaded commit set, de-duped by name and sorted for a stable
 * filter control (HEAD first, then branch / remote / tag groups, alphabetical within).
 * The bare `HEAD` symbolic pointer is dropped — it's not a useful filter target (it always
 * tracks some other ref); filtering by an actual branch/tag is what the user wants. Pure.
 */
export function collectRefs(commits: CommitNode[]): GitRef[] {
  const byName = new Map<string, GitRef>();
  for (const c of commits) {
    for (const ref of c.refs) {
      if (ref.kind === 'head' && ref.name === 'HEAD') continue;
      if (!byName.has(ref.name)) byName.set(ref.name, ref);
    }
  }
  const order: Record<GitRef['kind'], number> = { head: 0, branch: 1, remote: 2, tag: 3 };
  return [...byName.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name),
  );
}

/**
 * Reachability set for a ref: the ref tip's commit PLUS all its ancestors, walking the
 * in-memory parent map over the already-loaded commit set (a pure BFS — no host call). The
 * tip is the commit decorated with `refName`; from it we follow `parents` transitively, but
 * only across commits present in `commits` (an ancestor older than the loaded page simply
 * isn't reached — "load more" then widens the walk). Returns the set of reachable shas; an
 * empty set if the ref isn't among the loaded commits. Pure.
 *
 * This is the spec's preferred ref filter (parent-walk reachability) over a mere decorated-by
 * match, so filtering by `main` shows main's whole history, not just its single tip commit.
 */
export function reachableFromRef(commits: CommitNode[], refName: string): Set<string> {
  const bySha = new Map<string, CommitNode>();
  for (const c of commits) bySha.set(c.sha, c);
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const c of commits) {
    if (hasRef(c, refName)) {
      queue.push(c.sha);
      reachable.add(c.sha);
    }
  }
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    const node = bySha.get(sha);
    if (!node) continue;
    for (const p of node.parents) {
      if (!reachable.has(p) && bySha.has(p)) {
        reachable.add(p);
        queue.push(p);
      }
    }
  }
  return reachable;
}

/**
 * Narrow a commit list by an optional text query AND an optional ref-name filter (both
 * applied; a commit must satisfy each active filter). The ref filter keeps commits REACHABLE
 * from the ref tip (the tip + its ancestors via the in-memory parent walk), not merely the
 * commit the ref decorates. Preserves the input order (so the caller can re-run `assignLanes`
 * on the result for a correct lane layout over the subset). Pure.
 */
export function filterCommits(
  commits: CommitNode[],
  query: string,
  refName: string | null,
): CommitNode[] {
  const reachable = refName === null ? null : reachableFromRef(commits, refName);
  return commits.filter(
    (c) => matchesQuery(c, query) && (reachable === null || reachable.has(c.sha)),
  );
}

/**
 * Drop a stale history response: true when its `responseId` is not the latest the renderer
 * issued (a slower earlier interrogation must not clobber a newer one). Mirrors
 * content-search's `isStaleResponse`. An undefined responseId is treated as never-stale
 * (legacy/untagged replies still apply). Pure.
 */
export function isStaleHistory(responseId: number | undefined, latestId: number): boolean {
  if (responseId === undefined) return false;
  return responseId !== latestId;
}

/** The history view's lifecycle phase. Defined here (not the component) so the phase-transition
 *  helper below stays pure and unit-testable without a DOM. */
export type HistoryPhase = 'loading' | 'ready' | 'empty' | 'error' | 'loading-more';

/**
 * Resolve the view phase after a `git:historyResult` arrives. A fresh (non-append) read
 * surfaces the terminal 'empty'/'error' states (the latter driving the retry UI); an OK read
 * settles to 'ready'. An append (Load more) NEVER wipes the loaded set — a failed or empty
 * page just drops back to 'ready' with the existing rows. Pure.
 */
export function phaseAfterResult(resultState: HistoryState, append: boolean): HistoryPhase {
  if (append) return 'ready';
  if (resultState === 'error') return 'error';
  if (resultState === 'empty') return 'empty';
  return 'ready';
}

export interface VisibleRange {
  /** First row index to render (inclusive). */
  start: number;
  /** One past the last row index to render (exclusive). */
  end: number;
}

/**
 * Fixed-height windowing math: which row indices fall in (or near) the viewport given the
 * scroll offset, viewport height, and per-row height. `overscan` extends the window a few
 * rows past each edge so a fast scroll doesn't flash blank rows. Clamped to [0, total].
 * Pure — the component multiplies `start * rowHeight` for the translate offset and renders
 * only `[start, end)`. A zero/negative viewport (unmeasured ref) still yields the overscan
 * head so the first paint isn't empty.
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan: number,
): VisibleRange {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const firstVisible = Math.floor(top / rowHeight);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + visibleCount + overscan);
  return { start, end };
}

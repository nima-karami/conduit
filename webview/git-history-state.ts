import { type HistoryPhase, isStaleHistory, phaseAfterResult } from '../src/git-search';
import type { CommitNode, HistoryState as HistoryReadState } from '../src/protocol';

export interface HistoryState {
  phase: HistoryPhase;
  /** The full loaded set (across pages). Filtering/virtualization derive from this. */
  commits: CommitNode[];
  hasMore: boolean;
  /** Full-history search hits for the active query (host-side `searchHistory`), kept SEPARATE
   *  from the paged `commits` so clearing the query restores the pristine paged graph. Folded
   *  into the display via `dedupeAndSortCommits` only while a query is active. Empty otherwise. */
  searchCommits: CommitNode[];
  /** The highlighted row (the commit whose tab is open / last activated). */
  selectedSha: string | null;
  query: string;
  /** Active ref-name filter, or null = all refs. */
  refFilter: string | null;
}

export type HistoryAction =
  | { type: 'request' }
  | { type: 'requestMore' }
  | {
      type: 'result';
      commits: CommitNode[];
      hasMore: boolean;
      append: boolean;
      state: HistoryReadState;
    }
  | { type: 'searchResult'; commits: CommitNode[] }
  | { type: 'select'; sha: string | null }
  | { type: 'setQuery'; query: string }
  | { type: 'setRefFilter'; refName: string | null }
  | { type: 'retarget' };

export const initialHistoryState: HistoryState = {
  phase: 'loading',
  commits: [],
  hasMore: false,
  searchCommits: [],
  selectedSha: null,
  query: '',
  refFilter: null,
};

// The host tags each result with a 3-state outcome (ok/empty/error), so a transient failure
// enters 'error' (retry UI) while a valid commit-less repo enters 'empty'. `phaseAfterResult`
// owns the transition (and the rule that an append never wipes the loaded set).
export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'request':
      // Preserve the user's search/filter (and any deep-history hits) across a refresh; only the
      // paged data resets. A re-typed query re-searches; a git-change refresh keeps prior hits.
      return {
        ...initialHistoryState,
        phase: 'loading',
        query: state.query,
        refFilter: state.refFilter,
        searchCommits: state.searchCommits,
      };
    case 'requestMore':
      return { ...state, phase: 'loading-more' };
    case 'result': {
      // A transient error (a focus/fingerprint auto-refresh or a paging read while git is briefly
      // locked) must NOT destroy an already-loaded view. On an error result keep the existing
      // commits AND hasMore (the empty/false error payload would otherwise blank the graph or
      // permanently hide "Load more"); only fall to the error+retry screen when nothing was loaded.
      if (action.state === 'error') {
        return { ...state, phase: state.commits.length > 0 ? 'ready' : 'error' };
      }
      const commits = action.append ? [...state.commits, ...action.commits] : action.commits;
      // Keep the selection only if the selected commit still exists after the refresh; else
      // clear it (and its in-flight diff) so the detail drawer doesn't point at a gone sha.
      const selectionAlive =
        state.selectedSha !== null && commits.some((c) => c.sha === state.selectedSha);
      // A ref the user was filtering by may vanish on refresh (branch deleted) — drop the
      // filter back to "all" so the view doesn't strand them on an empty result.
      const refStillPresent =
        state.refFilter === null ||
        commits.some((c) => c.refs.some((r) => r.name === state.refFilter));
      return {
        ...state,
        phase: phaseAfterResult(action.state, action.append),
        commits,
        hasMore: action.hasMore,
        selectedSha: selectionAlive ? state.selectedSha : null,
        refFilter: refStillPresent ? state.refFilter : null,
      };
    }
    case 'searchResult':
      return { ...state, searchCommits: action.commits };
    case 'select':
      return { ...state, selectedSha: action.sha };
    case 'setQuery':
      // Clearing the query drops the deep-history hits so the pristine paged graph returns.
      return {
        ...state,
        query: action.query,
        searchCommits: action.query.trim() ? state.searchCommits : [],
      };
    case 'setRefFilter':
      return { ...state, refFilter: action.refName };
    case 'retarget':
      return { ...initialHistoryState, query: state.query };
  }
}

/** Drop a `git:historyResult` unless it is this view's session and repo (both undefined counts)
 *  and the latest request of its kind (a query-tagged reply is a search). */
export function acceptHistoryResult(
  msg: { sessionId: string; repoRoot?: string; requestId?: number; query?: string },
  view: {
    sessionId: string | undefined;
    repoRoot: string | undefined;
    latestReqId: number;
    latestSearchReqId: number;
  },
): boolean {
  if (msg.sessionId !== view.sessionId || msg.repoRoot !== view.repoRoot) return false;
  const latest = msg.query?.trim() ? view.latestSearchReqId : view.latestReqId;
  return !isStaleHistory(msg.requestId, latest);
}

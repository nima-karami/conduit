import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  assignLanes,
  edgePaths,
  gutterWidth,
  isMerge,
  laneColorVar,
  laneX,
  NODE_RADIUS,
  ROW_HEIGHT,
  rowY,
  splitBadges,
} from '../../src/git-graph-render';
import { collectRefs, filterCommits, isStaleHistory, visibleRange } from '../../src/git-search';
import type {
  CommitNode,
  FileDiffDTO,
  GitRef,
  GraphLayout,
  HostToWebview,
} from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { IconBranch, IconClose, IconCopy, IconExternal, IconRefresh, IconSearch } from '../icons';
import { relativeTime } from '../relative-time';
import { useEscapeKey } from '../use-escape-key';
import { DiffViewer } from './diff-viewer';
import { EmptyState } from './empty-state';

/**
 * git-history view — the commit-graph "ledger". A singleton center-pane doc (one per
 * session, scoped to that session's repo). Sends `git:history` on open + page; renders a
 * crisp SVG lane gutter beside dense commit rows; selecting a commit slides in a detail
 * drawer with the full message + changed files; choosing a file renders that commit's diff
 * in the EXISTING DiffViewer. The graph + the backend are host-side — the renderer holds
 * only the serialized layout.
 *
 * Slice B adds: client-side search (sha/message/author) + a ref/branch filter (lanes are
 * RE-COMPUTED over the filtered subset so no dangling edges show); fixed-height row
 * virtualization (only on-screen rows render, the SVG gutter is windowed to match);
 * refresh-on-change wired to the indicator's seams (the session's git fingerprint changing
 * + window focus), debounced, with a request-id stale-drop so a slow earlier response
 * can't clobber a newer interrogation.
 *
 * The host returns an empty result for both an empty repo AND a not-a-git-repo cwd, so the
 * renderer cannot distinguish the two; an empty result shows one neutral "no history"
 * state that covers both (documented limitation).
 */

const STR = {
  title: 'History',
  loading: 'Loading history…',
  loadingMore: 'Loading more…',
  loadMore: 'Load more',
  empty: 'No history yet',
  emptyHint:
    'This view shows the commit graph once the active session is in a git repo with commits.',
  error: "Couldn't load history",
  errorHint: 'The git read timed out or failed. Try again.',
  retry: 'Retry',
  refresh: 'Refresh',
  changedFiles: 'Changed files',
  noChangedFiles: 'No file changes in this commit.',
  loadingDiff: 'Loading changed files…',
  viewDiff: 'View diff',
  back: 'Back to files',
  copySha: 'Copy full SHA',
  copied: 'Copied',
  mergeNote: 'Diff shown against the first parent.',
  selectCommit: 'Select a commit to inspect it.',
  commits: (n: number) => `${n} commit${n === 1 ? '' : 's'}`,
  searchPlaceholder: 'Search sha, message, author…',
  searchLabel: 'Search commits',
  clearSearch: 'Clear search',
  allRefs: 'All branches',
  filterLabel: 'Filter by ref',
  noMatch: 'No commits match',
  noMatchHint: 'Try a different search or clear the filter.',
  filteredCount: (shown: number, total: number) => `${shown} of ${total}`,
} as const;

const MAX_BADGES = 3;
/** Extra rows rendered past each viewport edge so a fast scroll doesn't flash blanks. */
const OVERSCAN = 8;
const REF_KIND_LABEL: Record<GitRef['kind'], string> = {
  head: 'HEAD',
  branch: 'branch',
  remote: 'remote',
  tag: 'tag',
};
/** Debounce for the refresh-on-change seam (git fingerprint change / window focus). */
const REFRESH_DEBOUNCE_MS = 400;

type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'loading-more';

interface State {
  phase: Phase;
  /** The full loaded set (across pages). Filtering/virtualization derive from this. */
  commits: CommitNode[];
  hasMore: boolean;
  selectedSha: string | null;
  /** Per-sha changed-file diffs collected from `fileDiff` after a `git:commitDiff`. */
  diffsBySha: Record<string, FileDiffDTO[]>;
  /** Shas whose commitDiff stream has settled (a short timeout after the request) —
   *  distinguishes "still loading" from a genuine zero-file commit. */
  settledShas: Record<string, true>;
  /** The changed file currently shown in the inline DiffViewer (path), or null = file list. */
  openFile: string | null;
  query: string;
  /** Active ref-name filter, or null = all refs. */
  refFilter: string | null;
}

type Action =
  | { type: 'request' }
  | { type: 'requestMore' }
  | {
      type: 'result';
      commits: CommitNode[];
      hasMore: boolean;
      append: boolean;
    }
  | { type: 'select'; sha: string | null }
  | { type: 'commitDiff'; sha: string; doc: FileDiffDTO }
  | { type: 'settleDiff'; sha: string }
  | { type: 'openFile'; path: string | null }
  | { type: 'setQuery'; query: string }
  | { type: 'setRefFilter'; refName: string | null };

const initialState: State = {
  phase: 'loading',
  commits: [],
  hasMore: false,
  selectedSha: null,
  diffsBySha: {},
  settledShas: {},
  openFile: null,
  query: '',
  refFilter: null,
};

// A history read has no error CHANNEL (the host resolves a failure to an empty result),
// so a "real" error can't be distinguished from empty here; we never enter 'error' from a
// result. The retry button re-requests, which is the correct recovery for both empty and a
// transient failure.
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'request':
      // Preserve the user's search/filter across a refresh (Slice B); only the data resets.
      return { ...initialState, phase: 'loading', query: state.query, refFilter: state.refFilter };
    case 'requestMore':
      return { ...state, phase: 'loading-more' };
    case 'result': {
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
        phase: commits.length === 0 ? 'empty' : 'ready',
        commits,
        hasMore: action.hasMore,
        selectedSha: selectionAlive ? state.selectedSha : null,
        openFile: selectionAlive ? state.openFile : null,
        refFilter: refStillPresent ? state.refFilter : null,
      };
    }
    case 'select':
      return { ...state, selectedSha: action.sha, openFile: null };
    case 'commitDiff': {
      // The sha is carried on the action (from the in-flight ref), not read off reducer
      // state — a large commit's diff can stream in AFTER the settle timer has nulled the
      // pending sha, and those late files must still attribute to the right commit.
      const existing = state.diffsBySha[action.sha] ?? [];
      if (existing.some((d) => d.path === action.doc.path)) return state;
      return {
        ...state,
        diffsBySha: { ...state.diffsBySha, [action.sha]: [...existing, action.doc] },
      };
    }
    case 'settleDiff':
      return { ...state, settledShas: { ...state.settledShas, [action.sha]: true } };
    case 'openFile':
      return { ...state, openFile: action.path };
    case 'setQuery':
      return { ...state, query: action.query };
    case 'setRefFilter':
      return { ...state, refFilter: action.refName };
  }
}

export function GitHistoryView({ sessionId }: { sessionId: string | undefined }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Monotonic request id; every interrogation bumps it so a slow earlier `git:historyResult`
  // can be dropped when a newer one has superseded it (concurrent-refresh guard).
  const reqCounter = useRef(0);
  const latestReqId = useRef(0);
  const appendRef = useRef(false);

  // `soft` (a refresh-on-change / the refresh button) re-interrogates WITHOUT wiping the
  // current rows + selection — the arriving `result` reconciles them (keeps the selection if
  // the commit survives). A hard request (initial open / retry) shows the loading state.
  const requestHistory = useCallback(
    (before?: string, soft = false) => {
      if (!sessionId) return;
      reqCounter.current += 1;
      latestReqId.current = reqCounter.current;
      appendRef.current = Boolean(before);
      if (before) dispatch({ type: 'requestMore' });
      else if (!soft) dispatch({ type: 'request' });
      post({
        type: 'git:history',
        sessionId,
        requestId: reqCounter.current,
        ...(before ? { before } : {}),
      });
    },
    [sessionId],
  );

  // Load on open + whenever the owning session changes.
  useEffect(() => {
    requestHistory();
  }, [requestHistory]);

  // Subscribe to history results (filtered to this session, newest-id-wins) + commit-diff
  // fileDiff replies. A `state` broadcast carrying this session's changed git fingerprint
  // is the refresh seam (debounced below).
  // Tracks the commit whose diff is in flight, for attributing streamed `fileDiff` replies.
  // Managed SOLELY by the select effect (set on select, cleared on deselect) — deliberately
  // NOT synced to the reducer's `pendingDiffSha` each render, because that field is nulled by
  // the settle timer and a large commit's diff can still be streaming in after settle; the
  // ref must outlive settle so those late files attribute to the right commit.
  const pendingDiffShaRef = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitFingerprint = useRef<string | null>(null);
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  useEffect(() => {
    const scheduleRefresh = () => {
      if (!sessionId) return;
      // Don't pile a refresh on top of an initial load; only refresh a settled view.
      if (phaseRef.current === 'loading') return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => requestHistory(undefined, true), REFRESH_DEBOUNCE_MS);
    };

    const unsub = subscribe((msg: HostToWebview) => {
      if (msg.type === 'git:historyResult' && msg.sessionId === sessionId) {
        // Drop a stale (superseded) response so a slow earlier interrogation can't clobber.
        if (isStaleHistory(msg.requestId, latestReqId.current)) return;
        dispatch({
          type: 'result',
          commits: msg.commits,
          hasMore: msg.hasMore,
          append: appendRef.current,
        });
        appendRef.current = false;
      } else if (msg.type === 'fileDiff' && pendingDiffShaRef.current) {
        dispatch({ type: 'commitDiff', sha: pendingDiffShaRef.current, doc: msg.doc });
      } else if (msg.type === 'state') {
        // Same seam as the git indicator: GitInfo rides the `state` broadcast. When this
        // session's git fingerprint (branch/sha/dirty/op) changes, the history may have new
        // commits/branches → re-interrogate (debounced, no busy-polling).
        const session = msg.sessions.find((s) => s.id === sessionId);
        const g = session?.git;
        const fp = g
          ? `${g.kind}|${g.branch ?? ''}|${g.sha ?? ''}|${g.dirty ? 'd' : ''}|${g.operation ?? ''}`
          : null;
        if (fp !== gitFingerprint.current) {
          const first = gitFingerprint.current === null;
          gitFingerprint.current = fp;
          if (!first) scheduleRefresh();
        }
      }
    });

    // Window focus is the other indicator seam — a refocus may follow an external commit.
    const onFocus = () => scheduleRefresh();
    window.addEventListener('focus', onFocus);
    return () => {
      unsub();
      window.removeEventListener('focus', onFocus);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [sessionId, requestHistory]);

  const loadMore = useCallback(() => {
    const last = state.commits[state.commits.length - 1];
    if (!last) return;
    requestHistory(last.sha);
  }, [state.commits, requestHistory]);

  const select = useCallback((sha: string) => dispatch({ type: 'select', sha }), []);

  // Selecting a commit requests its diff once; the changed-files list comes from the
  // streamed `fileDiff` set. A short settle timeout marks the stream done (no terminator)
  // so a zero-file commit shows "no changes" rather than spinning.
  const settledRef = useRef(state.settledShas);
  settledRef.current = state.settledShas;
  useEffect(() => {
    const sha = state.selectedSha;
    if (!sha || !sessionId) {
      pendingDiffShaRef.current = null;
      return;
    }
    if (settledRef.current[sha]) {
      pendingDiffShaRef.current = null;
      return;
    }
    pendingDiffShaRef.current = sha;
    post({ type: 'git:commitDiff', sessionId, sha });
    // The host streams one fileDiff per file with no terminator; a settle timer flips the
    // "loading…" notice to "no changes" for a genuinely zero-file commit. Generous because a
    // big commit's diff can stream for a while under load — late files still attribute via
    // the ref above, so this only governs the empty-vs-loading display, never correctness.
    const t = setTimeout(() => dispatch({ type: 'settleDiff', sha }), 1500);
    return () => clearTimeout(t);
  }, [state.selectedSha, sessionId]);

  useEscapeKey(useCallback(() => dispatch({ type: 'select', sha: null }), []));

  // Refs present in the loaded set drive the filter control. Computed off the FULL set so a
  // ref filtered out of view is still listed (the user can switch to it).
  const refOptions = useMemo(() => collectRefs(state.commits), [state.commits]);

  // Client-side narrowing: text query + ref filter, then RE-RUN assignLanes over the subset
  // so lanes/edges only reference visible commits (no dangling edges to filtered-out rows).
  const visibleCommits = useMemo(
    () => filterCommits(state.commits, state.query, state.refFilter),
    [state.commits, state.query, state.refFilter],
  );
  const layout: GraphLayout = useMemo(() => assignLanes(visibleCommits), [visibleCommits]);

  const indexBySha = useMemo(() => {
    const m = new Map<string, number>();
    visibleCommits.forEach((c, i) => {
      m.set(c.sha, i);
    });
    return m;
  }, [visibleCommits]);

  const paths = useMemo(
    () => edgePaths(layout, (sha) => indexBySha.get(sha) ?? -1),
    [layout, indexBySha],
  );

  // Virtualization: track the scroller's scrollTop + height; render only the visible window
  // of rows. The SVG gutter is rendered full-height (cheap vector) but its NODE elements are
  // also windowed for parity, and the rows are translated by the window's pixel offset.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const range = useMemo(
    () => visibleRange(scrollTop, viewportH, ROW_HEIGHT, visibleCommits.length, OVERSCAN),
    [scrollTop, viewportH, visibleCommits.length],
  );

  const onRowKey = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(visibleCommits.length - 1, next));
        const target = visibleCommits[clamped];
        if (!target) return;
        select(target.sha);
        // Keep the moved selection in view (it may be outside the current window) before
        // focusing the row — scrollIntoView nudges the scroller, the window recomputes.
        const el = listRef.current;
        if (el) {
          const top = clamped * ROW_HEIGHT;
          const bottom = top + ROW_HEIGHT;
          if (top < el.scrollTop) el.scrollTop = top;
          else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
        }
        requestAnimationFrame(() => {
          listRef.current?.querySelector<HTMLElement>(`[data-row="${clamped}"]`)?.focus();
        });
      };
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(index + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(index - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = visibleCommits[index];
        const first = c && state.diffsBySha[c.sha]?.[0];
        if (first) dispatch({ type: 'openFile', path: first.path });
      }
    },
    [visibleCommits, state.diffsBySha, select],
  );

  if (state.phase === 'loading') {
    return (
      <div className="gh">
        <GhHeader sessionId={sessionId} onRefresh={() => requestHistory()} count={0} />
        <div className="gh__body gh__body--center">
          <EmptyState
            variant="pane"
            icon={<IconBranch size={26} />}
            title={STR.loading}
            role="status"
          />
        </div>
      </div>
    );
  }

  if (state.phase === 'empty') {
    return (
      <div className="gh">
        <GhHeader sessionId={sessionId} onRefresh={() => requestHistory()} count={0} />
        <div className="gh__body gh__body--center">
          <EmptyState
            variant="pane"
            icon={<IconBranch size={26} />}
            title={STR.empty}
            hint={STR.emptyHint}
          />
        </div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="gh">
        <GhHeader sessionId={sessionId} onRefresh={() => requestHistory()} count={0} />
        <div className="gh__body gh__body--center">
          <EmptyState
            variant="pane"
            icon={<IconBranch size={26} />}
            title={STR.error}
            hint={STR.errorHint}
            role="alert"
          />
          <button
            type="button"
            className="btn btn--primary gh__retry"
            onClick={() => requestHistory()}
          >
            {STR.retry}
          </button>
        </div>
      </div>
    );
  }

  const gutter = gutterWidth(layout.laneCount);
  const totalHeight = visibleCommits.length * ROW_HEIGHT;
  const selected = visibleCommits.find((c) => c.sha === state.selectedSha) ?? null;
  const selectedLane = selected ? (layout.rows[indexBySha.get(selected.sha) ?? -1]?.lane ?? 0) : 0;
  const offsetY = range.start * ROW_HEIGHT;
  const windowCommits = visibleCommits.slice(range.start, range.end);
  const filtered = state.query.trim() !== '' || state.refFilter !== null;

  return (
    <div className="gh">
      <GhHeader
        sessionId={sessionId}
        onRefresh={() => requestHistory(undefined, true)}
        count={state.commits.length}
        shown={filtered ? visibleCommits.length : undefined}
      />
      <GhFilterBar
        query={state.query}
        refFilter={state.refFilter}
        refOptions={refOptions}
        searchRef={searchRef}
        onQuery={(q) => dispatch({ type: 'setQuery', query: q })}
        onRefFilter={(r) => dispatch({ type: 'setRefFilter', refName: r })}
      />
      <div className="gh__split">
        {visibleCommits.length === 0 ? (
          <div className="gh__body gh__body--center">
            <EmptyState
              variant="pane"
              icon={<IconSearch size={24} />}
              title={STR.noMatch}
              hint={STR.noMatchHint}
            />
          </div>
        ) : (
          <div
            className="gh__list"
            ref={listRef}
            role="listbox"
            aria-label={STR.title}
            tabIndex={-1}
            onScroll={onScroll}
          >
            {/* A full-height spacer gives the scroller its true scroll range; the windowed
                rows + gutter are absolutely placed at the window's pixel offset. */}
            <div className="gh__scroll" style={{ height: totalHeight }}>
              <div
                className="gh__window"
                style={{
                  transform: `translateY(${offsetY}px)`,
                  ['--gh-gutter' as string]: `${gutter}px`,
                }}
              >
                <div className="gh__graph" style={{ width: gutter }}>
                  {/* Decorative vector gutter for the windowed rows. Y coords are LOCAL to
                      the window (row index − range.start), so the SVG stays aligned with the
                      translated rows; edges to off-window parents are simply clipped. */}
                  <svg
                    className="gh__svg"
                    width={gutter}
                    height={windowCommits.length * ROW_HEIGHT}
                    aria-hidden
                  >
                    {paths.map((p) => {
                      const from = indexBySha.get(p.fromSha) ?? -1;
                      const to = indexBySha.get(p.toSha) ?? -1;
                      // Only draw an edge that touches the window (either endpoint inside).
                      if (
                        (from < range.start || from >= range.end) &&
                        (to < range.start || to >= range.end)
                      ) {
                        return null;
                      }
                      return (
                        <path
                          key={`${p.fromSha}-${p.toSha}`}
                          className="gh__edge"
                          d={shiftPath(p.d, offsetY)}
                          style={{ stroke: `var(${laneColorVar(p.colorLane)})` }}
                        />
                      );
                    })}
                    {windowCommits.map((commit, wi) => {
                      const i = range.start + wi;
                      const row = layout.rows[i];
                      if (!row) return null;
                      const merge = isMerge(commit.parents);
                      const head = commit.refs.some((r) => r.kind === 'head');
                      const cx = laneX(row.lane);
                      const cy = rowY(wi);
                      const color = `var(${laneColorVar(row.lane)})`;
                      return (
                        <g key={row.sha}>
                          {head && (
                            <circle
                              className="gh__node-head"
                              cx={cx}
                              cy={cy}
                              r={NODE_RADIUS + 3}
                              style={{ stroke: 'var(--blue)' }}
                            />
                          )}
                          {merge ? (
                            <rect
                              className="gh__node gh__node--merge"
                              x={cx - NODE_RADIUS}
                              y={cy - NODE_RADIUS}
                              width={NODE_RADIUS * 2}
                              height={NODE_RADIUS * 2}
                              transform={`rotate(45 ${cx} ${cy})`}
                              style={{ stroke: color }}
                            />
                          ) : (
                            <circle
                              className="gh__node"
                              cx={cx}
                              cy={cy}
                              r={NODE_RADIUS}
                              style={{ fill: color }}
                            />
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>

                <div className="gh__rows">
                  {windowCommits.map((commit, wi) => {
                    const i = range.start + wi;
                    return (
                      <CommitRow
                        key={commit.sha}
                        commit={commit}
                        index={i}
                        selected={commit.sha === state.selectedSha}
                        onSelect={() => select(commit.sha)}
                        onKeyDown={(e) => onRowKey(e, i)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
            {state.hasMore && !filtered && (
              <div className="gh__more">
                <button
                  type="button"
                  className="btn gh__more-btn"
                  onClick={loadMore}
                  disabled={state.phase === 'loading-more'}
                >
                  {state.phase === 'loading-more' ? STR.loadingMore : STR.loadMore}
                </button>
              </div>
            )}
          </div>
        )}

        <CommitDetail
          commit={selected}
          lane={selectedLane}
          diffs={selected ? state.diffsBySha[selected.sha] : undefined}
          loading={selected ? !state.settledShas[selected.sha] : false}
          openFile={state.openFile}
          onOpenFile={(path) => dispatch({ type: 'openFile', path })}
        />
      </div>
    </div>
  );
}

/** Shift an SVG path's Y coordinates up by `dy` so a path computed in absolute row space
 *  draws correctly inside the window's translated coordinate system. The paths from
 *  `edgePaths` use only `M`/`L`/`C` with `x y` pairs, so every second number is a Y. */
function shiftPath(d: string, dy: number): string {
  let coordIndex = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (n) => {
    const isY = coordIndex % 2 === 1;
    coordIndex += 1;
    return isY ? String(Number(n) - dy) : n;
  });
}

function GhHeader({
  sessionId,
  onRefresh,
  count,
  shown,
}: {
  sessionId: string | undefined;
  onRefresh: () => void;
  count: number;
  shown?: number;
}) {
  return (
    <div className="gh__head">
      <span className="gh__head-title">{STR.title}</span>
      {count > 0 && (
        <span className="gh__head-sub">
          {shown !== undefined ? STR.filteredCount(shown, count) : STR.commits(count)}
        </span>
      )}
      <span className="gh__head-spacer" />
      <button
        type="button"
        className="gh__head-btn"
        title={STR.refresh}
        aria-label={STR.refresh}
        onClick={onRefresh}
        disabled={!sessionId}
      >
        <IconRefresh size={14} />
      </button>
    </div>
  );
}

function GhFilterBar({
  query,
  refFilter,
  refOptions,
  searchRef,
  onQuery,
  onRefFilter,
}: {
  query: string;
  refFilter: string | null;
  refOptions: GitRef[];
  searchRef: React.RefObject<HTMLInputElement>;
  onQuery: (q: string) => void;
  onRefFilter: (r: string | null) => void;
}) {
  return (
    <div className="gh__filterbar">
      <div className="searchbox gh__searchbox">
        <IconSearch size={13} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={STR.searchPlaceholder}
          aria-label={STR.searchLabel}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="gh__search-clear"
            title={STR.clearSearch}
            aria-label={STR.clearSearch}
            onClick={() => {
              onQuery('');
              searchRef.current?.focus();
            }}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>
      {refOptions.length > 0 && (
        <select
          className="gh__reffilter"
          value={refFilter ?? ''}
          aria-label={STR.filterLabel}
          onChange={(e) => onRefFilter(e.target.value || null)}
        >
          <option value="">{STR.allRefs}</option>
          {refOptions.map((ref) => (
            <option key={`${ref.kind}:${ref.name}`} value={ref.name}>
              {ref.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const shortSha = (sha: string) => sha.slice(0, 7);

function CommitRow({
  commit,
  index,
  selected,
  onSelect,
  onKeyDown,
}: {
  commit: CommitNode;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const { visible, overflow } = splitBadges(commit.refs, MAX_BADGES);
  const date = relativeTime(commit.date * 1000);
  return (
    <div
      className={`gh__row${selected ? ' gh__row--selected' : ''}`}
      data-row={index}
      role="option"
      aria-selected={selected}
      aria-label={`${shortSha(commit.sha)} ${commit.subject} — ${commit.author}, ${date}`}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className="gh__sha">{shortSha(commit.sha)}</span>
      <span className="gh__subject" title={commit.subject}>
        {commit.subject}
      </span>
      <span className="gh__badges">
        {visible.map((ref) => (
          <span
            key={`${ref.kind}:${ref.name}`}
            className={`gh__badge gh__badge--${ref.kind}`}
            title={`${REF_KIND_LABEL[ref.kind]}: ${ref.name}`}
          >
            {ref.name}
          </span>
        ))}
        {overflow > 0 && <span className="gh__badge gh__badge--more">+{overflow}</span>}
      </span>
      <span className="gh__author">{commit.author}</span>
      <span className="gh__date">{date}</span>
    </div>
  );
}

function CommitDetail({
  commit,
  lane,
  diffs,
  loading,
  openFile,
  onOpenFile,
}: {
  commit: CommitNode | null;
  lane: number;
  diffs: FileDiffDTO[] | undefined;
  loading: boolean;
  openFile: string | null;
  onOpenFile: (path: string | null) => void;
}) {
  const [copied, setCopied] = useReducer((_: boolean, v: boolean) => v, false);
  const copy = useCallback(() => {
    if (!commit) return;
    void navigator.clipboard?.writeText(commit.sha);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [commit]);

  if (!commit) {
    return (
      <aside className="gh__detail gh__detail--empty">
        <EmptyState variant="pane" icon={<IconBranch size={22} />} title={STR.selectCommit} />
      </aside>
    );
  }

  const merge = isMerge(commit.parents);
  const open = openFile ? diffs?.find((d) => d.path === openFile) : undefined;
  const date = new Date(commit.date * 1000);
  const laneColor = `var(${laneColorVar(lane)})`;

  if (open) {
    return (
      <aside className="gh__detail gh__detail--diff" style={{ borderTopColor: laneColor }}>
        <div className="gh__detail-bar">
          <button type="button" className="gh__back" onClick={() => onOpenFile(null)}>
            ← {STR.back}
          </button>
          <span className="gh__detail-path" title={open.path}>
            {open.path}
          </span>
          {merge && <span className="gh__merge-note">{STR.mergeNote}</span>}
        </div>
        <div className="gh__diff">
          <DiffViewer doc={open} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="gh__detail" style={{ borderTopColor: laneColor }}>
      <div className="gh__detail-head">
        <div className="gh__detail-sha">
          <span className="gh__detail-sha-text">{commit.sha}</span>
          <button
            type="button"
            className="gh__copy"
            onClick={copy}
            title={STR.copySha}
            aria-label={STR.copySha}
          >
            <IconCopy size={13} />
            {copied && <span className="gh__copied">{STR.copied}</span>}
          </button>
        </div>
        <div className="gh__detail-meta">
          <span className="gh__detail-author">{commit.author}</span>
          {commit.email && <span className="gh__detail-email">{commit.email}</span>}
          <span className="gh__detail-date">{date.toLocaleString()}</span>
        </div>
        {commit.refs.length > 0 && (
          <div className="gh__detail-refs">
            {commit.refs.map((ref) => (
              <span
                key={`${ref.kind}:${ref.name}`}
                className={`gh__badge gh__badge--${ref.kind}`}
                title={REF_KIND_LABEL[ref.kind]}
              >
                {ref.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="gh__message">
        <p className="gh__message-subject">{commit.subject}</p>
        {commit.body && <pre className="gh__message-body">{commit.body}</pre>}
      </div>

      <div className="gh__files">
        <div className="gh__files-head">
          <span>{STR.changedFiles}</span>
          {merge && <span className="gh__merge-note">{STR.mergeNote}</span>}
        </div>
        {loading && (diffs?.length ?? 0) === 0 ? (
          <div className="gh__files-notice">{STR.loadingDiff}</div>
        ) : (diffs?.length ?? 0) === 0 ? (
          <div className="gh__files-notice">{STR.noChangedFiles}</div>
        ) : (
          <ul className="gh__file-list">
            {(diffs ?? []).map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  className="gh__file"
                  onClick={() => onOpenFile(d.path)}
                  title={STR.viewDiff}
                >
                  <IconExternal size={12} className="gh__file-icon" />
                  <span className="gh__file-path">{d.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

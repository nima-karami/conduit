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
import type { CommitNode, GitRef, GraphLayout, HostToWebview } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { IconBranch, IconClose, IconRefresh, IconSearch } from '../icons';
import { relativeTime } from '../relative-time';
import { useEscapeKey } from '../use-escape-key';
import { CommitView } from './commit-view';
import { EmptyState } from './empty-state';

/**
 * git-history view — the commit-graph "ledger". A singleton center-pane doc (one per
 * session, scoped to that session's repo). Sends `git:history` on open + page; renders a
 * crisp SVG lane gutter beside dense commit rows. It's a vertical master-detail: the ledger
 * fills the pane; selecting a commit reveals its detail (message + changed files, rendered
 * by `CommitView`) in a resizable bottom pane (draggable seam). Opening a changed FILE from
 * that detail opens its diff as a `commit-diff` editor tab (preview / pin). The graph +
 * backend are host-side.
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
  commits: (n: number) => `${n} commit${n === 1 ? '' : 's'}`,
  searchPlaceholder: 'Search sha, message, author…',
  searchLabel: 'Search commits',
  clearSearch: 'Clear search',
  allRefs: 'All branches',
  filterLabel: 'Filter by ref',
  noMatch: 'No commits match',
  noMatchHint: 'Try a different search or clear the filter.',
  filteredCount: (shown: number, total: number) => `${shown} of ${total}`,
  resizeDetail: 'Resize commit detail (drag, or Up/Down arrows)',
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
  /** The highlighted row (the commit whose tab is open / last activated). */
  selectedSha: string | null;
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
  | { type: 'setQuery'; query: string }
  | { type: 'setRefFilter'; refName: string | null };

const initialState: State = {
  phase: 'loading',
  commits: [],
  hasMore: false,
  selectedSha: null,
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
        refFilter: refStillPresent ? state.refFilter : null,
      };
    }
    case 'select':
      return { ...state, selectedSha: action.sha };
    case 'setQuery':
      return { ...state, query: action.query };
    case 'setRefFilter':
      return { ...state, refFilter: action.refName };
  }
}

/** Default and bounds for the detail pane's height (px); the user drags the seam to taste. */
const DETAIL_DEFAULT_H = 300;
const DETAIL_MIN_H = 140;
/** Min space kept for the ledger above the detail pane so it can't be dragged shut. */
const LEDGER_MIN_H = 160;
const DETAIL_KEY_STEP = 24;

export function GitHistoryView({
  sessionId,
  onOpenCommitFile,
}: {
  sessionId: string | undefined;
  /** Open one of the selected commit's files as a `commit-diff` editor tab — `pin`
   *  distinguishes single-click (preview) from double-click / Enter (pinned). */
  onOpenCommitFile?: (sha: string, file: string, pin: boolean) => void;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [detailH, setDetailH] = useState(DETAIL_DEFAULT_H);

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

  // Subscribe to history results (filtered to this session, newest-id-wins). A `state`
  // broadcast carrying this session's changed git fingerprint is the refresh seam
  // (debounced below). Commit detail + diffs are fetched by the commit/commit-diff tabs.
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

  // Select a commit → highlight the row + reveal its detail in the bottom pane.
  const selectCommit = useCallback((commit: CommitNode) => {
    dispatch({ type: 'select', sha: commit.sha });
  }, []);

  // Escape closes the detail pane (clears the selection).
  useEscapeKey(useCallback(() => dispatch({ type: 'select', sha: null }), []));

  // Clamp the detail pane to the split's current height so a window resize can't strand it
  // taller than the pane (the ledger keeps at least LEDGER_MIN_H).
  const clampDetailH = useCallback((h: number) => {
    const splitH = splitRef.current?.clientHeight ?? Number.POSITIVE_INFINITY;
    return Math.max(DETAIL_MIN_H, Math.min(splitH - LEDGER_MIN_H, h));
  }, []);

  // Drag the seam: track the pointer against the split's bottom edge. Window-level listeners
  // (not the handle's) so a fast drag that outruns the 6px strip keeps resizing.
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const split = splitRef.current;
      if (!split) return;
      const onMove = (ev: PointerEvent) => {
        const rect = split.getBoundingClientRect();
        setDetailH(clampDetailH(rect.bottom - ev.clientY));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('gh-resizing');
      };
      document.body.classList.add('gh-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [clampDetailH],
  );

  const onResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      // Up grows the detail pane (seam moves up), Down shrinks it — matching the drag.
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setDetailH((h) => clampDetailH(h + DETAIL_KEY_STEP));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setDetailH((h) => clampDetailH(h - DETAIL_KEY_STEP));
      }
    },
    [clampDetailH],
  );

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
      // Arrow keys move the highlighted row and reveal its detail (selection follows focus);
      // Enter does the same (keyboard has no double-click, and there's no per-row pin).
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(visibleCommits.length - 1, next));
        const target = visibleCommits[clamped];
        if (!target) return;
        selectCommit(target);
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
        if (c) selectCommit(c);
      }
    },
    [visibleCommits, selectCommit],
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
  const offsetY = range.start * ROW_HEIGHT;
  const windowCommits = visibleCommits.slice(range.start, range.end);
  const filtered = state.query.trim() !== '' || state.refFilter !== null;
  // Looked up in the FULL set so the detail pane survives a search that filters the row out
  // of view (the selection persists; only its row highlight may not be visible).
  const selectedCommit = state.selectedSha
    ? (state.commits.find((c) => c.sha === state.selectedSha) ?? null)
    : null;

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
      <div className="gh__split" ref={splitRef}>
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
                        onSelect={() => selectCommit(commit)}
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
        {selectedCommit && (
          <>
            <div
              className="gh__resizer"
              role="separator"
              aria-orientation="horizontal"
              aria-label={STR.resizeDetail}
              title={STR.resizeDetail}
              tabIndex={0}
              onPointerDown={onResizeStart}
              onKeyDown={onResizeKey}
            />
            <div className="gh__detail" style={{ height: detailH }}>
              <CommitView
                sessionId={sessionId}
                commit={selectedCommit}
                onOpenFile={(file, pin) => onOpenCommitFile?.(selectedCommit.sha, file, pin)}
              />
            </div>
          </>
        )}
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
  /** Click: highlight the row + reveal the commit's detail in the bottom pane. */
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

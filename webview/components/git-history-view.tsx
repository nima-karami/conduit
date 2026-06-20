import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
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
import type {
  CommitNode,
  FileDiffDTO,
  GitRef,
  GraphLayout,
  HostToWebview,
} from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { IconBranch, IconCopy, IconExternal, IconRefresh } from '../icons';
import { relativeTime } from '../relative-time';
import { useEscapeKey } from '../use-escape-key';
import { DiffViewer } from './diff-viewer';
import { EmptyState } from './empty-state';

/**
 * git-history Slice A — the commit-graph view. A singleton center-pane doc (one per
 * session, scoped to that session's repo). Sends `git:history` on open + page; renders a
 * crisp SVG lane gutter beside dense commit rows (the "ledger"); selecting a commit slides
 * in a detail drawer with the full message + changed files; choosing a file renders that
 * commit's diff in the EXISTING DiffViewer (reuse, not reinvented). The graph + the
 * backend are host-side — the renderer holds only the serialized layout.
 *
 * The host returns an empty result for both an empty repo AND a not-a-git-repo cwd, so the
 * renderer cannot distinguish the two; an empty result shows one neutral "no history"
 * state that covers both (documented limitation; Slice B can split them with a flag).
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
} as const;

const MAX_BADGES = 3;
const REF_KIND_LABEL: Record<GitRef['kind'], string> = {
  head: 'HEAD',
  branch: 'branch',
  remote: 'remote',
  tag: 'tag',
};

type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'loading-more';

interface State {
  phase: Phase;
  commits: CommitNode[];
  layout: GraphLayout;
  hasMore: boolean;
  selectedSha: string | null;
  /** Per-sha changed-file diffs collected from `fileDiff` after a `git:commitDiff`. */
  diffsBySha: Record<string, FileDiffDTO[]>;
  /** Shas whose commitDiff stream has settled (no terminator from the host, so this is
   *  set by a short timeout after the request) — distinguishes "still loading" from a
   *  genuine zero-file commit. */
  settledShas: Record<string, true>;
  /** The sha whose commitDiff is in flight (so late replies for a stale sha are ignored). */
  pendingDiffSha: string | null;
  /** The changed file currently shown in the inline DiffViewer (path), or null = file list. */
  openFile: string | null;
}

type Action =
  | { type: 'request' }
  | { type: 'requestMore' }
  | {
      type: 'result';
      commits: CommitNode[];
      layout: GraphLayout;
      hasMore: boolean;
      append: boolean;
    }
  | { type: 'select'; sha: string | null }
  | { type: 'requestCommitDiff'; sha: string }
  | { type: 'commitDiff'; doc: FileDiffDTO }
  | { type: 'settleDiff'; sha: string }
  | { type: 'openFile'; path: string | null };

const initialState: State = {
  phase: 'loading',
  commits: [],
  layout: { rows: [], edges: [], laneCount: 0 },
  hasMore: false,
  selectedSha: null,
  diffsBySha: {},
  settledShas: {},
  pendingDiffSha: null,
  openFile: null,
};

// A history read has no error CHANNEL (the host resolves a failure to an empty result),
// so a "real" error can't be distinguished from empty here; we never enter 'error' from a
// result. The error state stays reachable only if a future host signal adds one — the
// retry button re-requests, which is the correct recovery for both empty and a transient
// failure. (Documented in the view header.)
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'request':
      return { ...initialState, phase: 'loading' };
    case 'requestMore':
      return { ...state, phase: 'loading-more' };
    case 'result': {
      const commits = action.append ? [...state.commits, ...action.commits] : action.commits;
      return {
        ...state,
        phase: commits.length === 0 ? 'empty' : 'ready',
        commits,
        layout: action.layout,
        hasMore: action.hasMore,
      };
    }
    case 'select':
      return { ...state, selectedSha: action.sha, openFile: null };
    case 'requestCommitDiff':
      return { ...state, pendingDiffSha: action.sha };
    case 'commitDiff': {
      const sha = state.pendingDiffSha;
      if (!sha) return state;
      const existing = state.diffsBySha[sha] ?? [];
      // The host streams one fileDiff per changed file; accumulate, de-duped by path.
      if (existing.some((d) => d.path === action.doc.path)) return state;
      return { ...state, diffsBySha: { ...state.diffsBySha, [sha]: [...existing, action.doc] } };
    }
    case 'settleDiff':
      // Clear the pending sha too so a later working-tree `fileDiff` (review/diff doc) can't
      // be misattributed to this commit once its short collection window has closed.
      return {
        ...state,
        settledShas: { ...state.settledShas, [action.sha]: true },
        pendingDiffSha: state.pendingDiffSha === action.sha ? null : state.pendingDiffSha,
      };
    case 'openFile':
      return { ...state, openFile: action.path };
  }
}

export function GitHistoryView({ sessionId }: { sessionId: string | undefined }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const listRef = useRef<HTMLDivElement>(null);

  const requestHistory = useCallback(
    (before?: string) => {
      if (!sessionId) return;
      dispatch(before ? { type: 'requestMore' } : { type: 'request' });
      post({ type: 'git:history', sessionId, ...(before ? { before } : {}) });
    },
    [sessionId],
  );

  // Load on open + whenever the owning session changes (the doc transfers ownership to the
  // session that opened it, so a re-open under another repo re-interrogates).
  useEffect(() => {
    requestHistory();
  }, [requestHistory]);

  // Subscribe to history results (filtered to this session) + commit-diff fileDiff replies.
  const pendingDiffShaRef = useRef<string | null>(null);
  pendingDiffShaRef.current = state.pendingDiffSha;
  const appendRef = useRef(false);
  useEffect(() => {
    return subscribe((msg: HostToWebview) => {
      if (msg.type === 'git:historyResult' && msg.sessionId === sessionId) {
        dispatch({
          type: 'result',
          commits: msg.commits,
          layout: msg.layout,
          hasMore: msg.hasMore,
          append: appendRef.current,
        });
        appendRef.current = false;
      } else if (msg.type === 'fileDiff' && pendingDiffShaRef.current) {
        dispatch({ type: 'commitDiff', doc: msg.doc });
      }
    });
  }, [sessionId]);

  const loadMore = useCallback(() => {
    const last = state.commits[state.commits.length - 1];
    if (!last) return;
    appendRef.current = true;
    requestHistory(last.sha);
  }, [state.commits, requestHistory]);

  const select = useCallback((sha: string) => dispatch({ type: 'select', sha }), []);

  // Selecting a commit requests its diff once; the changed-files list comes from the
  // streamed `fileDiff` set. A short settle timeout marks the stream done (the host sends
  // no terminator) so a zero-file commit shows "no changes" rather than spinning. A
  // re-select of an already-settled sha skips the round-trip.
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
    dispatch({ type: 'requestCommitDiff', sha });
    post({ type: 'git:commitDiff', sessionId, sha });
    const t = setTimeout(() => dispatch({ type: 'settleDiff', sha }), 700);
    return () => clearTimeout(t);
  }, [state.selectedSha, sessionId]);

  useEscapeKey(useCallback(() => dispatch({ type: 'select', sha: null }), []));

  const indexBySha = useMemo(() => {
    const m = new Map<string, number>();
    state.commits.forEach((c, i) => {
      m.set(c.sha, i);
    });
    return m;
  }, [state.commits]);

  const paths = useMemo(
    () => edgePaths(state.layout, (sha) => indexBySha.get(sha) ?? -1),
    [state.layout, indexBySha],
  );

  const onRowKey = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(state.commits.length - 1, next));
        const target = state.commits[clamped];
        if (target) {
          select(target.sha);
          const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${clamped}"]`);
          el?.focus();
        }
      };
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(index + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(index - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = state.commits[index];
        const first = c && state.diffsBySha[c.sha]?.[0];
        if (first) dispatch({ type: 'openFile', path: first.path });
      }
    },
    [state.commits, state.diffsBySha, select],
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

  const gutter = gutterWidth(state.layout.laneCount);
  const svgHeight = state.commits.length * ROW_HEIGHT;
  const selected = state.commits.find((c) => c.sha === state.selectedSha) ?? null;
  const selectedLane = selected
    ? (state.layout.rows[indexBySha.get(selected.sha) ?? -1]?.lane ?? 0)
    : 0;

  return (
    <div className="gh">
      <GhHeader
        sessionId={sessionId}
        onRefresh={() => requestHistory()}
        count={state.commits.length}
      />
      <div className="gh__split">
        <div className="gh__list" ref={listRef} role="listbox" aria-label={STR.title} tabIndex={-1}>
          <div className="gh__graph" style={{ width: gutter }}>
            {/* Decorative vector gutter: lanes/edges/nodes. The textual row carries meaning. */}
            <svg
              className="gh__svg"
              width={gutter}
              height={svgHeight}
              viewBox={`0 0 ${gutter} ${svgHeight}`}
              aria-hidden
            >
              {paths.map((p) => (
                <path
                  key={`${p.fromSha}-${p.toSha}`}
                  className="gh__edge"
                  d={p.d}
                  style={{ stroke: `var(${laneColorVar(p.colorLane)})` }}
                />
              ))}
              {state.layout.rows.map((row, i) => {
                const commit = state.commits[i];
                const merge = commit ? isMerge(commit.parents) : false;
                const head = commit?.refs.some((r) => r.kind === 'head');
                const cx = laneX(row.lane);
                const cy = rowY(i);
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

          <div className="gh__rows" style={{ ['--gh-gutter' as string]: `${gutter}px` }}>
            {state.commits.map((commit, i) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                index={i}
                selected={commit.sha === state.selectedSha}
                onSelect={() => select(commit.sha)}
                onKeyDown={(e) => onRowKey(e, i)}
              />
            ))}
            {state.hasMore && (
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
        </div>

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

function GhHeader({
  sessionId,
  onRefresh,
  count,
}: {
  sessionId: string | undefined;
  onRefresh: () => void;
  count: number;
}) {
  return (
    <div className="gh__head">
      <span className="gh__head-title">{STR.title}</span>
      {count > 0 && <span className="gh__head-sub">{STR.commits(count)}</span>}
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
  // Echo the selected commit's lane hue on the drawer's top edge — ties selection to topology.
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

import {
  memo,
  type FocusEvent as ReactFocusEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangeDTO, FileDiffDTO } from '../../src/protocol';
import {
  computeFileReview,
  type FileReview,
  type ReviewHunk,
  type ReviewLine,
} from '../../src/review-hunks';
import type { ReviewSource } from '../docs';
import { joinPath } from '../file-tree';
import { IconChevron, IconExternal, IconReview } from '../icons';
import { commitChangesFromFiles, reviewSourceLabel } from '../review-commit';
import { computeWindow, estimateCardHeight, planRowCap } from '../review-window';
import { useCommitFiles } from '../use-commit-files';
import { useEscapeKey } from '../use-escape-key';
import { EmptyState } from './empty-state';
import { ImageDiff } from './image-diff';

/**
 * R3 — Review mode. One scrollable view stacking ALL working-tree changes as hunk-level
 * diff cards, unchanged runs collapsed into expandable folds. Rendered as plain styled
 * rows (NOT N Monaco editors — too heavy for a whole-tree review); hunk/fold extraction
 * is the pure `computeFileReview`. Read-only v1.
 *
 * The outer card list is WINDOWED (spec 2026-06-27-review-virtualization.md): only cards
 * intersecting the viewport (plus an overscan) mount, so a changeset of thousands of files
 * opens instantly and scrolls flat. The windowing math is the pure `computeWindow`; this
 * component owns the DOM glue (scroll metrics, measured-height cache, on-mount diff fetch).
 */

/** Vertical gap between cards (mirrors the old flex `gap`); baked into each slot height so
 *  spacer math and the real DOM agree. */
const GAP = 16;
/** Cap on rendered diff rows per card — shows a bounded, compact PORTION of a large file with a
 *  "Show all" expander, instead of the whole 1000-line file. Folds already collapse unchanged
 *  runs, so the visible rows are dominated by changed lines (spec 2026-06-29-review-changes-polish
 *  §5, Decision D4). */
const MAX_CARD_ROWS = 40;

declare global {
  interface Window {
    /** Dev/test perf counters read by the virtualization load-test e2e (gated to numbers). */
    __conduitReviewPerf?: {
      mountedCardCount: number;
      requestedDiffCount: number;
      lastWindow: { startIndex: number; endIndex: number; totalHeight: number };
    };
  }
}
/** Announce a window jump to SR users only when the range moves by more than this. */
const ANNOUNCE_THRESHOLD = 8;
const NO_MEASURED = new Map<number, number>();

interface FoldShown {
  topShown: number;
  botShown: number;
}
/** Per-card interaction state lifted out of the card components so it survives the unmount
 *  windowing causes (without this, an expanded diff silently collapses on scroll). */
interface CardUiState {
  folds: Map<number, FoldShown>;
  /** Cap state — now a two-way toggle: false shows the portion + "Show all", true shows every row. */
  showRemaining: boolean;
  /** Whole-card collapse (spec 2026-06-29-review-card-collapse §2.1): body hidden, header only. */
  collapsed: boolean;
}

export function ReviewView({
  changesRoot,
  changes,
  diffs,
  onRequestDiff,
  onJumpToHunk,
  onClose,
  source,
  sessionId,
}: {
  /** The active repo root — change paths are relative to it (multi-repo workspaces). */
  changesRoot: string | undefined;
  /** Working-tree changes (the Changes panel's list). One review card per file. */
  changes: ChangeDTO[];
  /** Diff content keyed by ABSOLUTE path (head/work), filled in as the host replies. */
  diffs: Map<string, FileDiffDTO>;
  /** Ask the host for a file's diff (absolute path). Called once per changed file. */
  onRequestDiff: (absPath: string) => void;
  /** Open the file in the editor revealed at a hunk's WORK line. */
  onJumpToHunk: (absPath: string, line: number) => void;
  onClose: () => void;
  /** What this Review tab is scoped to (working tree vs. a commit). Absent ⇒ working. */
  source?: ReviewSource;
  /** Owning session — scopes the commit-files loader to its repo. */
  sessionId?: string;
}) {
  useEscapeKey(onClose);

  const commitMode = source?.kind === 'commit';

  const absOf = useCallback(
    (rel: string) => (changesRoot ? joinPath(changesRoot, rel) : rel),
    [changesRoot],
  );

  // Commit source: the diffs are PRELOADED by the loader (git show), so the card list + diff
  // map are derived locally and fed to the SAME windowed renderer; `onRequestDiff` is a no-op
  // (every card's diff is already in the map). Working source is unchanged. See spec §3.2.
  // Rules of Hooks: always call the loader; an empty sha returns LOADING and posts nothing.
  const commit = useCommitFiles(sessionId, commitMode ? source.sha : '');
  const noopRequestDiff = useCallback(() => {}, []);
  const effectiveDiffs = useMemo(() => {
    if (!commitMode) return diffs;
    const m = new Map<string, FileDiffDTO>();
    for (const f of commit.files) m.set(absOf(f.path), f);
    return m;
  }, [commitMode, commit.files, diffs, absOf]);
  const effectiveChanges = useMemo(
    () => (commitMode ? commitChangesFromFiles(commit.files) : changes),
    [commitMode, commit.files, changes],
  );
  const effectiveRequestDiff = commitMode ? noopRequestDiff : onRequestDiff;
  const commitLoading = commitMode && commit.status === 'loading';

  // A change can appear twice (staged + unstaged side); review each PATH once.
  const files = useMemo(() => {
    const seen = new Set<string>();
    const out: ChangeDTO[] = [];
    for (const c of effectiveChanges) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push(c);
    }
    return out;
  }, [effectiveChanges]);

  const pathIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < files.length; i++) m.set(files[i].path, i);
    return m;
  }, [files]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  // path → measured SLOT height (card border-box + GAP); keyed by path so it survives
  // re-scan/reorder of `changes` (index is not stable, path is).
  const measuredRef = useRef<Map<string, number>>(new Map());
  // Absolute paths already requested — dedupes a card scrolled out and back (Decision D1).
  const requestedRef = useRef<Set<string>>(new Set());
  // Per-path UI state cache (fold reveals + "Show remaining"); see CardUiState.
  const uiCacheRef = useRef<Map<string, CardUiState>>(new Map());

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Bumped purely to force a re-render when a measured height changes (the cache lives in a ref
  // for stable closures, so mutating it doesn't re-render on its own). `win` is recomputed
  // inline below, so the next render reads the fresh cache — otherwise totalHeight + padBottom
  // stay estimate-based until the next scroll and the first scroll jumps.
  const [, setMeasureTick] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  // Reset scroll + focus when the SOURCE changes so a stale offset can't strand the user
  // mid-list, and announce the new source to SR users (spec §4 + §10). The per-path caches
  // are keyed by path and harmlessly carry across (different files).
  const sourceKey = source?.kind === 'commit' ? `commit:${source.sha}` : 'working';
  // biome-ignore lint/correctness/useExhaustiveDependencies: must fire only on a source CHANGE (sourceKey), not when the referenced setters/source re-identify; see spec §4.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
    setFocusedPath(null);
    setAnnounce(`Now ${reviewSourceLabel(source).replace(/^Reviewing /, 'reviewing ')}`);
  }, [sourceKey]);

  const estimateSlot = useCallback(
    (c: ChangeDTO) => estimateCardHeight(c.added, c.removed) + GAP,
    [],
  );
  const heightOf = useCallback(
    (i: number) => measuredRef.current.get(files[i].path) ?? estimateSlot(files[i]),
    [files, estimateSlot],
  );

  // Computed inline (not memoized): heightOf reads the measured-height cache through a ref, so
  // memoizing on stable deps would miss measurement updates. computeWindow is O(count) and pure;
  // re-running it each render keeps the spacers honest for the cost of a cheap index walk.
  const win = computeWindow({
    count: files.length,
    scrollTop,
    viewportHeight,
    // ~1 viewport of overscan on each side absorbs fling without mounting the world.
    overscanPx: viewportHeight,
    estimate: heightOf,
    measured: NO_MEASURED,
  });

  // Pin a focused card in the window so it never unmounts while it holds focus (Decision D3):
  // extend the contiguous range to include it and recompute the spacers from the same heights.
  const view = useMemo(() => {
    let { startIndex, endIndex, padTop, padBottom, totalHeight } = win;
    const fi = focusedPath ? (pathIndex.get(focusedPath) ?? -1) : -1;
    if (endIndex >= startIndex && fi >= 0 && (fi < startIndex || fi > endIndex)) {
      const start = Math.min(startIndex, fi);
      const end = Math.max(endIndex, fi);
      let top = 0;
      for (let i = 0; i < start; i++) top += heightOf(i);
      let span = 0;
      for (let i = start; i <= end; i++) span += heightOf(i);
      startIndex = start;
      endIndex = end;
      padTop = top;
      padBottom = totalHeight - top - span;
    }
    return { startIndex, endIndex, padTop, padBottom, totalHeight };
  }, [win, focusedPath, pathIndex, heightOf]);

  // Observe the scroller's own height (viewport changes on resize / font-scale / tab show).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-measure invalidation on font-scale change: row heights are scale-derived, so cached
  // measurements would misplace cards. Drop the cache and re-measure on the next mount.
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => {
      measuredRef.current.clear();
      setMeasureTick((t) => t + 1);
    });
    obs.observe(root, { attributes: true, attributeFilter: ['style'] });
    return () => obs.disconnect();
  }, []);

  const onMeasure = useCallback(
    (path: string, cardHeight: number) => {
      const slot = cardHeight + GAP;
      const prev = measuredRef.current.get(path) ?? estimateSlot(files[pathIndex.get(path) ?? 0]);
      if (measuredRef.current.get(path) === slot) return;
      measuredRef.current.set(path, slot);

      // Scroll anchoring: if a card ABOVE the top-most visible card changes height, shift the
      // scroller by the delta so the content under the viewport stays put (no jump).
      const el = scrollerRef.current;
      const idx = pathIndex.get(path);
      if (el && idx !== undefined) {
        let offset = 0;
        let topVisible = files.length;
        for (let i = 0; i < files.length; i++) {
          const h = heightOf(i);
          if (offset + h > el.scrollTop) {
            topVisible = i;
            break;
          }
          offset += h;
        }
        if (idx < topVisible) el.scrollTop += slot - prev;
      }
      setMeasureTick((t) => t + 1);
    },
    [files, pathIndex, estimateSlot, heightOf],
  );

  // Request-once diff fetch: a card requests its diff when it mounts (enters the window) if
  // not already requested. Only windowed cards mount, so in-flight fetches are bounded by the
  // window size — no explicit concurrency cap needed (Decision D1).
  const requestOnce = useCallback(
    (abs: string) => {
      if (requestedRef.current.has(abs)) return;
      requestedRef.current.add(abs);
      effectiveRequestDiff(abs);
    },
    [effectiveRequestDiff],
  );

  const setCardUi = useCallback((path: string, next: CardUiState) => {
    uiCacheRef.current.set(path, next);
  }, []);

  // Announce large window jumps to SR users (the off-window cards aren't in the AT tree).
  const lastAnnouncedRef = useRef(-ANNOUNCE_THRESHOLD);
  useEffect(() => {
    if (files.length === 0 || view.endIndex < view.startIndex) return;
    if (Math.abs(view.startIndex - lastAnnouncedRef.current) < ANNOUNCE_THRESHOLD) return;
    lastAnnouncedRef.current = view.startIndex;
    setAnnounce(`Showing files ${view.startIndex + 1}–${view.endIndex + 1} of ${files.length}`);
  }, [view.startIndex, view.endIndex, files.length]);

  // Dev/test perf hook — read by the load-test e2e. Just numbers; cheap enough to attach
  // unconditionally (mirrors webview/log.ts's window.__conduitLog seam).
  const mountedCardCount =
    view.endIndex >= view.startIndex ? view.endIndex - view.startIndex + 1 : 0;
  useEffect(() => {
    window.__conduitReviewPerf = {
      mountedCardCount,
      requestedDiffCount: requestedRef.current.size,
      lastWindow: {
        startIndex: view.startIndex,
        endIndex: view.endIndex,
        totalHeight: view.totalHeight,
      },
    };
  });

  const onFocusCapture = useCallback((e: ReactFocusEvent) => {
    const card = (e.target as HTMLElement).closest('.rcard');
    const p = card?.getAttribute('data-path');
    if (p) setFocusedPath(p);
  }, []);
  const onBlurCapture = useCallback((e: ReactFocusEvent) => {
    if (!scrollerRef.current?.contains(e.relatedTarget as Node | null)) setFocusedPath(null);
  }, []);

  const anyInFlight = useMemo(() => {
    for (let i = view.startIndex; i <= view.endIndex; i++) {
      if (!effectiveDiffs.get(absOf(files[i].path))) return true;
    }
    return false;
  }, [view.startIndex, view.endIndex, files, effectiveDiffs, absOf]);

  const mounted: ChangeDTO[] = [];
  if (view.endIndex >= view.startIndex) {
    for (let i = view.startIndex; i <= view.endIndex; i++) mounted.push(files[i]);
  }

  return (
    <div className="review">
      <div className="review__head">
        <span className="review__title">Review changes</span>
        <span className="review__sub">
          {files.length === 0
            ? 'No changes to review'
            : `${files.length} file${files.length === 1 ? '' : 's'} changed`}
        </span>
      </div>

      <div
        ref={scrollerRef}
        className="review__scroll"
        onScroll={() => {
          const el = scrollerRef.current;
          if (el) setScrollTop(el.scrollTop);
        }}
        onFocus={onFocusCapture}
        onBlur={onBlurCapture}
        aria-busy={anyInFlight}
      >
        {files.length === 0 ? (
          commitLoading ? (
            <EmptyState
              variant="pane"
              icon={<IconReview size={28} />}
              title="Loading commit changes…"
              role="status"
            />
          ) : commitMode ? (
            <EmptyState
              variant="pane"
              icon={<IconReview size={28} />}
              title="No changes in this commit"
              hint="This commit has no readable file changes."
            />
          ) : (
            <EmptyState
              variant="pane"
              icon={<IconReview size={28} />}
              title="Nothing to review"
              hint="The working tree is clean — make some changes and they'll show up here."
            />
          )
        ) : (
          <>
            <div className="review__pad" style={{ height: view.padTop }} aria-hidden />
            {mounted.map((c) => (
              <ReviewFileCard
                key={c.path}
                change={c}
                abs={absOf(c.path)}
                diff={effectiveDiffs.get(absOf(c.path))}
                uiCache={uiCacheRef.current}
                onUiChange={setCardUi}
                onMeasure={onMeasure}
                onRequestOnce={requestOnce}
                onJumpToHunk={onJumpToHunk}
              />
            ))}
            <div className="review__pad" style={{ height: view.padBottom }} aria-hidden />
          </>
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      </div>
    </div>
  );
}

const emptyUi = (): CardUiState => ({ folds: new Map(), showRemaining: false, collapsed: false });

// Memoized: the host streams diffs in one at a time (each updates the `diffs` Map but
// keeps every other file's FileDiffDTO identity), so without this every card — and its
// whole hunk/line tree — reconciles on each arrival. With a stable `diff` ref per file,
// a card now renders once when its own diff lands. Relies on the callback props being stable.
const ReviewFileCard = memo(function ReviewFileCard({
  change,
  abs,
  diff,
  uiCache,
  onUiChange,
  onMeasure,
  onRequestOnce,
  onJumpToHunk,
}: {
  change: ChangeDTO;
  abs: string;
  diff: FileDiffDTO | undefined;
  uiCache: Map<string, CardUiState>;
  onUiChange: (path: string, next: CardUiState) => void;
  onMeasure: (path: string, cardHeight: number) => void;
  onRequestOnce: (absPath: string) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  const review: FileReview | null = useMemo(() => {
    if (!diff || diff.binary) return null;
    return computeFileReview(diff.head, diff.work);
  }, [diff]);

  // Fetch this card's diff on mount (entering the window). The dedupe set in the parent makes
  // a re-entry a no-op; a diff already present needs no fetch.
  useEffect(() => {
    if (!diff) onRequestOnce(abs);
  }, [abs, diff, onRequestOnce]);

  // Measure the card's real height; re-measure on grow (diff arrival, fold expand, image load).
  const rootRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = () => onMeasure(change.path, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [change.path, onMeasure]);

  // Local interaction state seeded from (and written back to) the per-path cache so the card
  // looks exactly as the user left it after scrolling out and back.
  const [ui, setUiState] = useState<CardUiState>(() => uiCache.get(change.path) ?? emptyUi());
  const setUi = useCallback(
    (updater: (prev: CardUiState) => CardUiState) =>
      setUiState((prev) => {
        const next = updater(prev);
        onUiChange(change.path, next);
        return next;
      }),
    [change.path, onUiChange],
  );

  const parts = change.path.split('/');
  const file = parts.pop() ?? change.path;
  const dir = parts.join('/');

  const collapsed = ui.collapsed;
  // Collapsing UNMOUNTS the body, so aria-controls would dangle at a missing id — only set it
  // while expanded; aria-expanded carries the state either way (spec §10).
  const bodyId = useId();

  return (
    <section
      ref={rootRef}
      className="rcard"
      data-path={change.path}
      aria-label={`Changes in ${change.path}`}
    >
      <header className="rcard__head">
        <button
          type="button"
          className="rcard__toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${change.path}`}
          onClick={() => setUi((prev) => ({ ...prev, collapsed: !prev.collapsed }))}
        >
          <IconChevron
            size={12}
            className={`rcard__chev${collapsed ? '' : ' rcard__chev--open'}`}
          />
          <span className={`change__kind change__kind--${change.kind}`}>{change.kind}</span>
          <span className="rcard__path">
            {dir && <span className="rcard__dir">{dir}/</span>}
            <span className="rcard__file">{file}</span>
          </span>
          <span className="rcard__stat">
            {change.added > 0 && <span className="diffstat--add">+{change.added}</span>}
            {change.removed > 0 && <span className="diffstat--del"> -{change.removed}</span>}
          </span>
        </button>
        <button
          type="button"
          className="rcard__open"
          title="Open this file in the editor"
          onClick={() => onJumpToHunk(abs, review?.hunks[0]?.startNewLine ?? 1)}
        >
          <IconExternal size={13} /> Open file
        </button>
      </header>

      {!collapsed && (
        <div id={bodyId}>
          {diff?.image ? (
            <ImageDiff doc={diff} />
          ) : diff?.binary ? (
            <div className="rcard__notice">Binary file — no diff preview.</div>
          ) : !review ? (
            <div className="rcard__notice rcard__notice--loading">Loading diff…</div>
          ) : review.hunks.length === 0 ? (
            <div className="rcard__notice">No textual changes.</div>
          ) : (
            <HunkList review={review} abs={abs} ui={ui} setUi={setUi} onJumpToHunk={onJumpToHunk} />
          )}
        </div>
      )}
    </section>
  );
});

function HunkList({
  review,
  abs,
  ui,
  setUi,
  onJumpToHunk,
}: {
  review: FileReview;
  abs: string;
  ui: CardUiState;
  setUi: (updater: (prev: CardUiState) => CardUiState) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  // A fold with index `i` sits before hunk `i`; index === hunks.length sits after the last.
  const foldsByIndex = useMemo(() => {
    const m = new Map<number, FileReview['folds'][number]>();
    for (const f of review.folds) m.set(f.index, f);
    return m;
  }, [review]);

  const lineCounts = useMemo(() => review.hunks.map((h) => h.lines.length), [review]);
  const total = useMemo(() => lineCounts.reduce((a, b) => a + b, 0), [lineCounts]);
  const { shown } = planRowCap(lineCounts, MAX_CARD_ROWS, ui.showRemaining);
  // A card whose rows fit under the cap has no portioning control at all (spec §2.1); only an
  // over-cap card gets the two-way "Show all" ⇄ "Show less".
  const capped = total > MAX_CARD_ROWS;

  const rows: JSX.Element[] = [];
  for (let i = 0; i <= review.hunks.length; i++) {
    const fold = foldsByIndex.get(i);
    if (fold) {
      const sh = ui.folds.get(i) ?? { topShown: 0, botShown: 0 };
      rows.push(
        <FoldRow
          key={`fold-${i}`}
          fold={fold}
          shown={sh}
          onChange={(next) =>
            setUi((prev) => ({ ...prev, folds: new Map(prev.folds).set(i, next) }))
          }
        />,
      );
    }
    const hunk = review.hunks[i];
    if (hunk) {
      rows.push(
        <Hunk
          key={`hunk-${i}`}
          hunk={hunk}
          maxLines={shown[i]}
          abs={abs}
          onJumpToHunk={onJumpToHunk}
        />,
      );
    }
  }
  return (
    <div className="rhunks">
      {rows}
      {capped &&
        (ui.showRemaining ? (
          <button
            type="button"
            className="rcard__showrest"
            onClick={() => setUi((prev) => ({ ...prev, showRemaining: false }))}
          >
            Show less
          </button>
        ) : (
          <button
            type="button"
            className="rcard__showrest"
            onClick={() => setUi((prev) => ({ ...prev, showRemaining: true }))}
          >
            Show all {total} lines
          </button>
        ))}
    </div>
  );
}

// How many lines each "expand up/down" click reveals from a fold.
const FOLD_STEP = 10;

/**
 * A collapsed run of unchanged lines between hunks, revealable incrementally from the top
 * or bottom (or all at once), like GitHub's diff expanders. Controlled by the parent so the
 * reveal survives the card unmounting (windowing) — see CardUiState.
 */
function FoldRow({
  fold,
  shown,
  onChange,
}: {
  fold: FileReview['folds'][number];
  shown: FoldShown;
  onChange: (next: FoldShown) => void;
}) {
  const total = fold.lines.length;
  const { topShown, botShown } = shown;
  const hidden = Math.max(0, total - topShown - botShown);
  const topLines = fold.lines.slice(0, topShown);
  const botLines = botShown > 0 ? fold.lines.slice(total - botShown) : [];

  const expandTop = () =>
    onChange({ topShown: Math.min(total - botShown, topShown + FOLD_STEP), botShown });
  const expandBottom = () =>
    onChange({ topShown, botShown: Math.min(total - topShown, botShown + FOLD_STEP) });
  const expandAll = () => onChange({ topShown: total, botShown: 0 });

  return (
    <div className="rfold">
      {topLines.map((l) => (
        <Line key={l.seq} line={l} />
      ))}
      {hidden > 0 && (
        <div className="rfold__bar">
          <button
            type="button"
            className="rfold__exp"
            onClick={expandTop}
            title="Show lines above"
            aria-label="Show lines above"
          >
            <IconChevron size={12} className="rfold__chev rfold__chev--up" />
          </button>
          <button type="button" className="rfold__count" onClick={expandAll} title="Show all">
            {hidden} unchanged line{hidden === 1 ? '' : 's'}
          </button>
          <button
            type="button"
            className="rfold__exp"
            onClick={expandBottom}
            title="Show lines below"
            aria-label="Show lines below"
          >
            <IconChevron size={12} className="rfold__chev rfold__chev--down" />
          </button>
        </div>
      )}
      {botLines.map((l) => (
        <Line key={l.seq} line={l} />
      ))}
    </div>
  );
}

function Hunk({
  hunk,
  maxLines,
  abs,
  onJumpToHunk,
}: {
  hunk: ReviewHunk;
  maxLines: number;
  abs: string;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  const lines = maxLines < hunk.lines.length ? hunk.lines.slice(0, maxLines) : hunk.lines;
  return (
    <div className="rhunk">
      <button
        type="button"
        className="rhunk__jump"
        title="Open this hunk in the editor"
        onClick={() => onJumpToHunk(abs, hunk.startNewLine)}
      >
        @ line {hunk.startNewLine}
      </button>
      <div className="rhunk__lines">
        {lines.map((l) => (
          <Line key={l.seq} line={l} />
        ))}
      </div>
    </div>
  );
}

const SIGN: Record<ReviewLine['kind'], string> = { context: ' ', add: '+', del: '-' };

function Line({ line }: { line: ReviewLine }) {
  const gutter =
    line.kind === 'add'
      ? `+${line.newLine ?? ''}`
      : line.kind === 'del'
        ? `-${line.oldLine ?? ''}`
        : `${line.newLine ?? ''}`;
  return (
    <pre className={`rline rline--${line.kind}`}>
      <span className="rline__gutter">{gutter}</span>
      <span className="rline__sign">{SIGN[line.kind]}</span>
      <span className="rline__text">{line.text === '' ? ' ' : line.text}</span>
    </pre>
  );
}

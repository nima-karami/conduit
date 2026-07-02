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
import { endpointLabel, rangeKey } from '../../src/git-range';
import { langFromPath } from '../../src/lang';
import type { ChangeDTO, FileDiffDTO } from '../../src/protocol';
import {
  computeFileReview,
  computeReplacementEmphasis,
  type FileReview,
  type ReviewHunk,
  type ReviewLine,
  type WordSpan,
} from '../../src/review-hunks';
import type { ReviewSource } from '../docs';
import { joinPath } from '../file-tree';
import { IconChevron, IconExternal, IconReview, IconSidebar } from '../icons';
import { commitChangesFromFiles, reviewSourceLabel } from '../review-commit';
import { computeDiffstat } from '../review-stats';
import {
  computeReviewAnchor,
  computeWindow,
  estimateCardHeight,
  planRowCap,
  resolveReviewAnchor,
} from '../review-window';
import { useSettings } from '../settings';
import { applyEmphasis, highlightLine, monacoLangToHljs } from '../syntax-highlight';
import { useCommitFiles } from '../use-commit-files';
import { useDebouncedFlush } from '../use-debounced-flush';
import { useEscapeKey } from '../use-escape-key';
import { retryRangeDiff, useRangeFiles } from '../use-range-files';
import {
  deleteViewState,
  getViewState,
  setViewState,
  VIEW_STATE_DEBOUNCE_MS,
} from '../view-state-store';
import { EmptyState } from './empty-state';
import { ImageDiff } from './image-diff';
// Shared syntax palette (also imported by markdown-viewer; esbuild dedupes). Explicit here so
// review rows keep their token colours even if markdown-viewer's import ever changes (spec D2).
import '../hljs-theme.css';

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
/** Stable empty list so the preloaded-files memo doesn't re-run for working/streaming sources. */
const EMPTY_FILES: FileDiffDTO[] = [];

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
  viewStateId,
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
  /** The owning doc id — keys this list's scroll-anchor memory (spec 2026-06-30). */
  viewStateId?: string;
}) {
  useEscapeKey(onClose);

  const commitMode = source?.kind === 'commit';
  const rangeMode = source?.kind === 'range';
  // Commit AND range sources both PRELOAD every file's diff (git show / git diff), so the same
  // code path feeds the windowed renderer from a derived list with a no-op on-mount fetch. Only
  // the working source streams per-card. See spec §3.2 + item 4 §A3.
  const preloaded = commitMode || rangeMode;

  // A terminal-originated commit review pins its own repo (source.repoRoot). Its change paths are
  // relative to THAT repo, so file-open / jump-to-hunk must join against it, not the pinned repo.
  const commitRepoRoot = commitMode ? source.repoRoot : undefined;
  const effectiveRoot = commitRepoRoot ?? changesRoot;

  const absOf = useCallback(
    (rel: string) => (effectiveRoot ? joinPath(effectiveRoot, rel) : rel),
    [effectiveRoot],
  );

  // Rules of Hooks: always call both loaders; an inactive one is fed empty args and posts nothing.
  const commit = useCommitFiles(sessionId, commitMode ? source.sha : '', commitRepoRoot);
  const range = useRangeFiles(
    sessionId,
    rangeMode ? source.base : undefined,
    rangeMode ? source.head : undefined,
  );
  const preloadedFiles = commitMode ? commit.files : rangeMode ? range.files : EMPTY_FILES;

  const noopRequestDiff = useCallback(() => {}, []);
  const effectiveDiffs = useMemo(() => {
    if (!preloaded) return diffs;
    const m = new Map<string, FileDiffDTO>();
    for (const f of preloadedFiles) m.set(absOf(f.path), f);
    return m;
  }, [preloaded, preloadedFiles, diffs, absOf]);
  const effectiveChanges = useMemo(
    () => (preloaded ? commitChangesFromFiles(preloadedFiles) : changes),
    [preloaded, preloadedFiles, changes],
  );
  const effectiveRequestDiff = preloaded ? noopRequestDiff : onRequestDiff;
  const preloadLoading =
    (commitMode && commit.status === 'loading') || (rangeMode && range.status === 'loading');
  const rangeError =
    rangeMode && range.status === 'error' ? (range.error ?? 'Unknown error') : null;

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

  // Diffstat header — a pure fold over the deduped file list the cards read (spec §Data). Exact
  // for all three sources; binary files count in `files` with 0 lines.
  const stat = useMemo(() => computeDiffstat(files), [files]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  // path → measured SLOT height (card border-box + GAP); keyed by path so it survives
  // re-scan/reorder of `changes` (index is not stable, path is).
  const measuredRef = useRef<Map<string, number>>(new Map());
  // Absolute paths already requested — dedupes a card scrolled out and back (Decision D1).
  const requestedRef = useRef<Set<string>>(new Set());
  // Per-path UI state cache (fold reveals + "Show remaining"); see CardUiState.
  const uiCacheRef = useRef<Map<string, CardUiState>>(new Map());
  // Scroll-anchor memory (spec 2026-06-30): in a ref so the [sourceKey]-only reset effect can
  // read the id without re-firing on prop re-identity. `scrollRestoredRef` makes restore one-shot;
  // `firstSourceRef` distinguishes the initial mount from a genuine source change (a content reset).
  const viewStateIdRef = useRef(viewStateId);
  viewStateIdRef.current = viewStateId;
  const scrollRestoredRef = useRef(false);
  const firstSourceRef = useRef(true);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Bumped purely to force a re-render when a measured height changes (the cache lives in a ref
  // for stable closures, so mutating it doesn't re-render on its own). `win` is recomputed
  // inline below, so the next render reads the fresh cache — otherwise totalHeight + padBottom
  // stay estimate-based until the next scroll and the first scroll jumps.
  const [, setMeasureTick] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const { settings, update } = useSettings();
  const navOpen = settings.reviewFileListOpen;
  // A navigator click sets this to (target path, bumped nonce); the target card's reveal effect
  // reads the nonce to expand itself even when it was already mounted+collapsed (a fresh mount
  // would seed collapsed from the ui cache, so the cache alone can't re-expand a mounted card).
  const [reveal, setReveal] = useState<{ path: string; nonce: number }>({ path: '', nonce: 0 });

  // Reset scroll + focus when the SOURCE changes so a stale offset can't strand the user
  // mid-list, and announce the new source to SR users (spec §4 + §10). The per-path caches
  // are keyed by path and harmlessly carry across (different files).
  const sourceKey =
    source?.kind === 'commit'
      ? `commit:${source.sha}`
      : source?.kind === 'range'
        ? `range:${rangeKey(source.base, source.head)}`
        : 'working';
  // biome-ignore lint/correctness/useExhaustiveDependencies: must fire only on a source CHANGE (sourceKey), not when the referenced setters/source re-identify; see spec §4.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
    setFocusedPath(null);
    setAnnounce(`Now ${reviewSourceLabel(source).replace(/^Reviewing /, 'reviewing ')}`);
    // A genuine source change is a content reset (spec §4): drop the saved anchor and don't
    // restore, so a stale offset can't strand the user. The initial mount keeps its saved anchor.
    if (firstSourceRef.current) {
      firstSourceRef.current = false;
    } else {
      const id = viewStateIdRef.current;
      if (id) deleteViewState(id);
      scrollRestoredRef.current = true;
    }
  }, [sourceKey]);

  const estimateSlot = useCallback(
    (c: ChangeDTO) => estimateCardHeight(c.added, c.removed) + GAP,
    [],
  );
  const heightOf = useCallback(
    (i: number) => measuredRef.current.get(files[i].path) ?? estimateSlot(files[i]),
    [files, estimateSlot],
  );

  // Capture the top-visible card anchor (computed live on scroll into a ref) so the final
  // unmount flush never reads a detached scroller. Debounced live capture (§3 / D5).
  const lastAnchorRef = useRef<{ topPath: string; offset: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const id = viewStateIdRef.current;
    if (id && lastAnchorRef.current)
      setViewState(id, { kind: 'reviewAnchor', ...lastAnchorRef.current });
  }, []);
  const { schedule: scheduleAnchorCapture } = useDebouncedFlush(
    captureAnchor,
    VIEW_STATE_DEBOUNCE_MS,
  );

  // Restore the saved anchor once the list has files + a measured viewport (the ready gate, §3);
  // estimate-based heights refine afterwards and onMeasure's scroll-anchoring keeps it stable. A
  // raw px scrollTop is wrong here — measured heights are per-instance and estimate-based on a
  // fresh mount (spec §4), so we resolve the path+offset anchor against the current heights.
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    const id = viewStateIdRef.current;
    if (!id || files.length === 0 || viewportHeight === 0) return;
    scrollRestoredRef.current = true;
    const saved = getViewState(id);
    if (saved?.kind !== 'reviewAnchor') return;
    const top = resolveReviewAnchor(saved, files.length, heightOf, (p) => pathIndex.get(p));
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, [files.length, viewportHeight, heightOf, pathIndex]);

  // Navigator click → scroll a file's card to the top of the viewport. Routed through the SAME
  // offset math the windower/anchor use (resolveReviewAnchor sums heightOf up to the target), so
  // setting scrollTop mounts + positions the card; the reveal nonce expands it if collapsed.
  const scrollToFile = useCallback(
    (path: string) => {
      const el = scrollerRef.current;
      if (!el || pathIndex.get(path) === undefined) return;
      const top = resolveReviewAnchor({ topPath: path, offset: 0 }, files.length, heightOf, (p) =>
        pathIndex.get(p),
      );
      el.scrollTop = top;
      setScrollTop(top);
      setReveal((r) => ({ path, nonce: r.nonce + 1 }));
    },
    [files.length, heightOf, pathIndex],
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

  // The navigator highlights the file nearest the viewport top — derived from the SAME anchor
  // math the scroll-memory uses (no new observer). Null before the list/viewport are measured.
  const activePath =
    files.length > 0
      ? (computeReviewAnchor(scrollTop, files.length, heightOf, (i) => files[i].path)?.topPath ??
        null)
      : null;

  return (
    <div className="review">
      <div className="review__head">
        {files.length > 0 && (
          <button
            type="button"
            className="review__navtoggle"
            aria-pressed={navOpen}
            aria-label={navOpen ? 'Hide file list' : 'Show file list'}
            title={navOpen ? 'Hide file list' : 'Show file list'}
            onClick={() => update({ reviewFileListOpen: !navOpen })}
          >
            <IconSidebar size={15} />
          </button>
        )}
        <span className="review__title">Review changes</span>
        <span className="review__sub">
          {files.length === 0 ? (
            'No changes to review'
          ) : (
            <>
              {stat.files} file{stat.files === 1 ? '' : 's'} changed{' · '}
              <span className="diffstat--add">+{stat.insertions}</span>{' '}
              <span className="diffstat--del">−{stat.deletions}</span>
            </>
          )}
        </span>
      </div>

      <div className="review__body">
        {navOpen && files.length > 0 && (
          <ReviewFileNav files={files} activePath={activePath} onPick={scrollToFile} />
        )}
        <div
          ref={scrollerRef}
          className="review__scroll"
          onScroll={() => {
            const el = scrollerRef.current;
            if (!el) return;
            setScrollTop(el.scrollTop);
            lastAnchorRef.current = computeReviewAnchor(
              el.scrollTop,
              files.length,
              heightOf,
              (i) => files[i].path,
            );
            scheduleAnchorCapture();
          }}
          onFocus={onFocusCapture}
          onBlur={onBlurCapture}
          aria-busy={anyInFlight}
        >
          {files.length === 0 ? (
            rangeError ? (
              <EmptyState
                variant="pane"
                icon={<IconReview size={28} />}
                title={`Couldn't compare: ${rangeError}`}
                hint="One of the chosen refs couldn't be resolved."
                action={
                  rangeMode && sessionId ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => retryRangeDiff(sessionId, source.base, source.head)}
                    >
                      Retry
                    </button>
                  ) : undefined
                }
              />
            ) : preloadLoading ? (
              <EmptyState
                variant="pane"
                icon={<IconReview size={28} />}
                title={rangeMode ? 'Loading comparison…' : 'Loading commit changes…'}
                role="status"
              />
            ) : rangeMode ? (
              <EmptyState
                variant="pane"
                icon={<IconReview size={28} />}
                title={`No differences between ${endpointLabel(source.base)} and ${endpointLabel(source.head)}`}
                hint="These two refs have identical content."
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
                  revealNonce={reveal.path === c.path ? reveal.nonce : 0}
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
    </div>
  );
}

/**
 * The Review file navigator (spec 2026-07-02-review-changes-first-class §"UI — the file
 * navigator"): a left sub-column listing every changed file. Presentational — it reads the same
 * deduped `files` the cards read and calls back into ReviewView's scroll machinery on a click.
 * A row with no line changes (binary/image, or a mode-only change) shows `—`, mirroring the
 * card header, which shows no `+/−` when both counts are 0.
 */
function ReviewFileNav({
  files,
  activePath,
  onPick,
}: {
  files: ChangeDTO[];
  activePath: string | null;
  onPick: (path: string) => void;
}) {
  return (
    <nav className="review__nav" aria-label="Changed files">
      <ul className="review__navlist">
        {files.map((c) => {
          const parts = c.path.split('/');
          const name = parts.pop() ?? c.path;
          const dir = parts.join('/');
          const active = c.path === activePath;
          const noLines = c.added === 0 && c.removed === 0;
          return (
            <li key={c.path}>
              <button
                type="button"
                className={`review__navrow${active ? ' review__navrow--active' : ''}`}
                data-path={c.path}
                aria-current={active ? 'true' : undefined}
                title={c.path}
                onClick={() => onPick(c.path)}
              >
                <span className={`change__kind change__kind--${c.kind}`}>{c.kind}</span>
                <span className="review__navpath">
                  {dir && <span className="review__navdir">{dir}/</span>}
                  <span className="review__navname">{name}</span>
                </span>
                <span className="review__navstat">
                  {noLines ? (
                    <span className="review__navdash">—</span>
                  ) : (
                    <>
                      {c.added > 0 && <span className="diffstat--add">+{c.added}</span>}
                      {c.removed > 0 && <span className="diffstat--del"> −{c.removed}</span>}
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
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
  revealNonce,
}: {
  change: ChangeDTO;
  abs: string;
  diff: FileDiffDTO | undefined;
  uiCache: Map<string, CardUiState>;
  onUiChange: (path: string, next: CardUiState) => void;
  onMeasure: (path: string, cardHeight: number) => void;
  onRequestOnce: (absPath: string) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
  /** Bumped by a navigator click targeting THIS card; a change (>0) expands it if collapsed. */
  revealNonce: number;
}) {
  const review: FileReview | null = useMemo(() => {
    if (!diff || diff.binary) return null;
    return computeFileReview(diff.head, diff.work);
  }, [diff]);

  // Resolve the language once per file (not per row); null ⇒ plain rows (spec §"Per-file language").
  const hljsLang = useMemo(() => monacoLangToHljs(langFromPath(change.path)), [change.path]);

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

  // Navigator reveal: a click on this file's row bumps revealNonce; expand if collapsed. Works
  // whether the card was already mounted (this fires) or freshly mounted by the scroll (nonce is
  // already >0 on first render, so the effect still runs).
  // biome-ignore lint/correctness/useExhaustiveDependencies: expand is keyed to the nonce bump alone, not setUi re-identity.
  useEffect(() => {
    if (revealNonce > 0) setUi((prev) => (prev.collapsed ? { ...prev, collapsed: false } : prev));
  }, [revealNonce]);

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
            <HunkList
              review={review}
              abs={abs}
              ui={ui}
              setUi={setUi}
              onJumpToHunk={onJumpToHunk}
              hljsLang={hljsLang}
            />
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
  hljsLang,
}: {
  review: FileReview;
  abs: string;
  ui: CardUiState;
  setUi: (updater: (prev: CardUiState) => CardUiState) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
  hljsLang: string | null;
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
          hljsLang={hljsLang}
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
          hljsLang={hljsLang}
        />,
      );
    }
  }
  return (
    <>
      <div className="rhunks">{rows}</div>
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
    </>
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
  hljsLang,
}: {
  fold: FileReview['folds'][number];
  shown: FoldShown;
  onChange: (next: FoldShown) => void;
  hljsLang: string | null;
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
        <Line key={l.seq} line={l} hljsLang={hljsLang} />
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
        <Line key={l.seq} line={l} hljsLang={hljsLang} />
      ))}
    </div>
  );
}

function Hunk({
  hunk,
  maxLines,
  abs,
  onJumpToHunk,
  hljsLang,
}: {
  hunk: ReviewHunk;
  maxLines: number;
  abs: string;
  onJumpToHunk: (absPath: string, line: number) => void;
  hljsLang: string | null;
}) {
  const lines = maxLines < hunk.lines.length ? hunk.lines.slice(0, maxLines) : hunk.lines;
  // Word-level emphasis for adjacent del→add replacement pairs (spec 2026-07-01-review-word-diff).
  // Computed over the FULL hunk (pairing is a hunk property, independent of the row cap) so each
  // emphasized line's span array keeps a stable identity across cap toggles — Line's memo relies
  // on it. Only mounted (windowed) cards run this, so it's off the scroll hot path.
  const emphBySeq = useMemo(() => computeReplacementEmphasis(hunk.lines), [hunk.lines]);
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
          <Line key={l.seq} line={l} hljsLang={hljsLang} emph={emphBySeq.get(l.seq)} />
        ))}
      </div>
    </div>
  );
}

const SIGN: Record<ReviewLine['kind'], string> = { context: ' ', add: '+', del: '-' };

// Memoized: a diff line's rendered token spans depend only on its (stable) `line` object, the
// card's `hljsLang`, and its (stable per hunk) `emph` spans, so skip re-tokenizing + rebuilding
// the span tree on unrelated parent re-renders (fold toggles, show-more, view-state) — the
// windowed hot path (spec §perf).
const Line = memo(function Line({
  line,
  hljsLang,
  emph,
}: {
  line: ReviewLine;
  hljsLang: string | null;
  /** Char spans that changed vs. this line's replacement counterpart; wrapped in `.rline__word`. */
  emph?: WordSpan[];
}) {
  const gutter =
    line.kind === 'add'
      ? `+${line.newLine ?? ''}`
      : line.kind === 'del'
        ? `-${line.oldLine ?? ''}`
        : `${line.newLine ?? ''}`;
  // Empty lines keep the nbsp placeholder (no tokenization); a plain-fallback row (hljsLang null)
  // renders one uncoloured span so today's solid green/red/dim text survives (spec D3).
  const baseSegs = line.text === '' ? null : highlightLine(line.text, hljsLang);
  // A row is "plain" (keeps today's solid green/red/dim text) when it has no coloured tokens:
  // an empty line, or a single uncoloured segment (unknown language / long-line / hljs fallback).
  const plain = baseSegs === null || (baseSegs.length === 1 && baseSegs[0].cls === null);
  // Overlay word-diff emphasis onto the syntax segments — composes: the emphasized sub-span keeps
  // its token colour and only gains the `.rline__word` background accent.
  const segs = baseSegs === null ? null : applyEmphasis(baseSegs, emph);
  return (
    <pre className={`rline rline--${line.kind}${plain ? '' : ' rline--hl'}`}>
      <span className="rline__gutter">{gutter}</span>
      <span className="rline__sign">{SIGN[line.kind]}</span>
      <span className="rline__text">
        {segs === null
          ? ' '
          : segs.map((s, i) => {
              const cls = s.emph ? (s.cls ? `${s.cls} rline__word` : 'rline__word') : s.cls;
              return cls === null ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
                <span key={i}>{s.text}</span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
                <span key={i} className={cls}>
                  {s.text}
                </span>
              );
            })}
      </span>
    </pre>
  );
});

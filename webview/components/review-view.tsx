import type {
  JSX as ReactJSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import {
  Fragment,
  memo,
  type FocusEvent as ReactFocusEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { folderKey } from '../../src/folder-key';
import type { HunkOp } from '../../src/git-actions';
import { endpointLabel } from '../../src/git-range';
import { hunkRange } from '../../src/hunk-patch';
import { langFromPath } from '../../src/lang';
import { anchorMenuToRect, type Rect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import { plural } from '../../src/plural';
import type {
  ChangeDTO,
  FileDiffDTO,
  RepoChanges,
  ReviewMark,
  ReviewNote,
} from '../../src/protocol';
import { repoBaseName } from '../../src/repo-display';
import type { RepoInfo } from '../../src/repo-scan';
import {
  buildGroupedHandoffMarkdown,
  buildHandoffMarkdown,
  type HandoffRepo,
  handoffLabel,
  handoffPathPrefix,
} from '../../src/review-handoff';
import {
  computeFileReview,
  computeReplacementEmphasis,
  type FileReview,
  formatHunkHeader,
  type ReviewHunk,
  type ReviewLine,
  type WordSpan,
} from '../../src/review-hunks';
import { contentHash, normalizeRoot, reviewedPaths, staleMarks } from '../../src/review-marks';
import {
  type AnchoredNote,
  anchorAt,
  canAddNote,
  type NoteSide,
  newNoteId,
  pendingNotes,
  reanchor,
  snippetOf,
} from '../../src/review-notes';
import type { RightPaneTab } from '../../src/settings';
import { gitAction } from '../bridge';
import { DIFF_READ_ERROR_NOTICE } from '../diff-tab-scope';
import type { OpenMode, ReviewSource } from '../docs';
import type { GitActionIntent } from '../git-intent';
import {
  applyHunkAction,
  BLOCKED_TOOLTIP,
  getHunkActionHost,
  type HunkButtonMode,
  hunkButtonMode,
  NO_HUNK_OPS_TOOLTIP,
  STAGED_DISCARD_TOOLTIP,
  subscribeHunkActionHost,
  UNMERGED_TOOLTIP,
  UNTRACKED_DISCARD_TOOLTIP,
  WHITESPACE_TOOLTIP,
} from '../hunk-actions';
import {
  IconCheck,
  IconChevron,
  IconCopy,
  IconExternal,
  IconFolder,
  IconMore,
  IconPanelRight,
  IconReview,
  IconSearch,
  IconSparkle,
  IconSplit,
} from '../icons';
import { middleClickProps } from '../middle-click';
import { commitChangesFromFiles, reviewSourceLabel } from '../review-commit';
import {
  clearReviewHighlights,
  highlightApiAvailable,
  paintReviewHighlights,
  rangeInRowText,
} from '../review-highlight';
import {
  clampRef,
  type HunkRef,
  INTERACTIVE_TARGET,
  nextFile,
  nextHunk,
  prevFile,
  prevHunk,
  REVIEW_KEY_HELP,
  type ReviewFileHunks,
  reviewActionAllowed,
  reviewActionFor,
  syncToAnchor,
} from '../review-keymap';
import { getMarksSnapshot, setReviewMark, subscribeMarks } from '../review-marks-store';
import { publishReviewNav, type ReviewNavModel } from '../review-nav-store';
import { getNoteTarget, subscribeNoteTarget } from '../review-note-target';
import {
  getNotesSnapshot,
  loadNotesFor,
  notesFor,
  notesLoaded,
  patchNotes,
  subscribeNotes,
} from '../review-notes-store';
import {
  cardDomKey,
  groupReviewFiles,
  isStaleWorkingRoot,
  type ReviewFile,
  type ReviewGroup,
  repoChipLabel,
  repoChipRows,
  repoDisplayPath,
  resolveReviewRepo,
  reviewFileKey,
  reviewRequestRoot,
  reviewViewKey,
  tagReviewFiles,
  workingReviewFiles,
} from '../review-repos';
import {
  diffsForScope,
  inScope,
  REVIEW_SCOPES,
  type ReviewScope,
  reviewSourceKey,
  SCOPE_LABEL,
  scopeOfSource,
  workingSource,
} from '../review-scope';
import {
  collectMatches,
  fileFilterMatches,
  partialLabel,
  type ReviewMatch,
  type ReviewSearchFile,
  stepMatch,
} from '../review-search';
import { computeDiffstat, computeReviewProgress } from '../review-stats';
import {
  computeReviewAnchor,
  computeWindow,
  estimateCardHeight,
  fileAtOrAfter,
  planRowCap,
  REVIEW_GROUP_HEAD_H,
  type ReviewListItem,
  resolveReviewAnchor,
  reviewListItems,
} from '../review-window';
import { useSettings } from '../settings';
import { applyEmphasis, highlightLine, monacoLangToHljs } from '../syntax-highlight';
import {
  getTerminalBusVersion,
  hasLiveTerminal,
  pasteToTerminal,
  subscribeTerminalBus,
} from '../terminal-bus';
import { pushToast } from '../toast-store';
import { isTypingEntry } from '../typing-guard';
import { retryCommitDiff, useCommitFiles } from '../use-commit-files';
import { useDebouncedFlush } from '../use-debounced-flush';
import { useElementWidth } from '../use-element-width';
import { useEscapeKey } from '../use-escape-key';
import { retryRangeDiff, useRangeFiles } from '../use-range-files';
import {
  acquireReviewListState,
  adoptReviewSource,
  type ReviewCardUi as CardUiState,
  type ReviewFoldShown as FoldShown,
  getViewState,
  mergeReviewViewState,
  type ReviewListState,
  VIEW_STATE_DEBOUNCE_MS,
} from '../view-state-store';
import { ConfirmDialog, type ConfirmState } from './confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { ImageDiff } from './image-diff';
import { DetachedNotes, NoteComposer, NoteThread } from './note-thread';
import { RepoTagPill } from './repo-picker-menu';
import { ReviewFindBar } from './review-find-bar';
import { ReviewRepoChip } from './review-repo-chip';
import { ReviewSourceControl } from './review-source-control';
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
/** Stable empty list so a repo with no marks doesn't re-identify the memo on every render. */
const EMPTY_MARKS: ReviewMark[] = [];
/** Stable identity, same reason as EMPTY_MARKS: an unnoted card must not re-run its memo. */
const EMPTY_NOTES: readonly ReviewNote[] = [];
const NO_GROUPS: ReviewGroup[] = [];
const NOTE_CAP_MESSAGE =
  'Resolve or delete some notes first — this repository is at 500 open notes.';
const STR = {
  discardPerRepo: 'Pick one repo to discard its changes',
} as const;

/** A card's DOM address: `data-path` stays repo-relative (e2e selectors read it), so two repos'
 *  same-path cards are told apart by `data-root`. */
const cardSelector = (f: Pick<ReviewFile, 'repoRoot' | 'path'>): string =>
  `.rcard[data-root="${CSS.escape(folderKey(f.repoRoot))}"][data-path="${CSS.escape(f.path)}"]`;

/** Where an open note composer sits. One at a time, owned by ReviewView (plan assumption 12). */
interface ComposerTarget {
  /** The card's file key; `root` + `path` are what the per-repo notes store is written with. */
  key: string;
  root: string;
  path: string;
  side: NoteSide;
  /** 1-based on `side`. */
  line: number;
  snippet: string;
  anchor: string;
}

/** Notes grouped by `<side>:<line>`, plus the ones that lost their place. */
interface AnchoredNotes {
  byLine: ReadonlyMap<string, ReviewNote[]>;
  detached: readonly AnchoredNote[];
}
const NO_NOTES: AnchoredNotes = { byLine: new Map(), detached: [] };

/**
 * FNV of a diff's new side, memoised on the DTO itself. The host streams diffs one at a time and
 * each arrival re-identifies the whole map, so a plain fold would re-hash every file already
 * loaded on every arrival — O(bytes loaded) per streamed file over a long scroll. A FileDiffDTO is
 * immutable and identity-stable per file, which makes it the natural cache key.
 */
const diffHashes = new WeakMap<FileDiffDTO, string>();
function hashOfDiff(d: FileDiffDTO): string {
  const seen = diffHashes.get(d);
  if (seen !== undefined) return seen;
  const h = contentHash(d.work);
  diffHashes.set(d, h);
  return h;
}

/**
 * `computeFileReview` memoised on the DTO identity, one entry per whitespace mode. Three
 * consumers need the SAME hunks — the card that renders them, the key handler that resolves the
 * current hunk, and search, which builds its corpus from every loaded file — and search would
 * otherwise re-diff the whole changeset on each keystroke.
 */
const diffReviews = new WeakMap<FileDiffDTO, Map<boolean, FileReview | null>>();
function reviewOfDiff(d: FileDiffDTO, ignoreWhitespace: boolean): FileReview | null {
  let per = diffReviews.get(d);
  if (!per) {
    per = new Map();
    diffReviews.set(d, per);
  }
  const seen = per.get(ignoreWhitespace);
  if (seen !== undefined) return seen;
  const value = d.binary
    ? null
    : computeFileReview(d.head, d.work, undefined, undefined, { ignoreWhitespace });
  per.set(ignoreWhitespace, value);
  return value;
}

/** Files "Search all files" asks the host for per pass; arrivals drive the next batch, so this
 *  is the in-flight ceiling rather than a pacing delay. */
const SEARCH_ALL_BATCH = 25;
/** Stable empty corpus so the search memo doesn't re-identify while the bar is closed. */
const NO_SEARCH_FILES: ReviewSearchFile[] = [];
/** A file that HAS loaded but has no searchable lines (binary, image). Distinct from `null`,
 *  which is "not fetched yet" and is what "in N of M files" counts. */
const NO_HUNKS: FileReview = { hunks: [], folds: [], added: 0, removed: 0 };
const MENU_W = 200;

export function ReviewView({
  reviewRepos,
  repoChanges,
  fallbackRoot,
  home,
  diffs,
  onRequestDiff,
  onJumpToHunk,
  onOpenDiff,
  onGitAction,
  onClose,
  source,
  sessionId,
  sessionLabel,
  viewStateId,
  onSetSource,
  onOpenCompare,
  paneTab,
  explorerCollapsed,
  onTogglePanel,
  onShowChanges,
}: {
  /** The session's present repos in display order — the repo chip's set (spec 2026-09-23-mf-review §2.1). */
  reviewRepos: readonly RepoInfo[];
  /** Each repo's working-tree changes, in display order. Undefined until the host first replies. */
  repoChanges: readonly RepoChanges[] | undefined;
  /** The root a source without one reads (`gitRootForSession`). */
  fallbackRoot: string | undefined;
  /** The session's home — the grouped handoff's path base (spec §3.3). */
  home: string | undefined;
  /** Diff content keyed by ABSOLUTE path (head/work), filled in as the host replies. */
  diffs: Map<string, FileDiffDTO>;
  /** Ask the host for a file's diff (absolute path) at the current scope. Once per changed file. */
  onRequestDiff: (absPath: string, scope: ReviewScope) => void;
  /** Open the file in the editor revealed at a hunk's WORK line. */
  onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
  /** Card header "Open side-by-side": open this file's real side-by-side diff (the dual
   *  gutters are the inline answer; this is the escape hatch for when they aren't enough). */
  onOpenDiff?: (absPath: string, scope: ReviewScope, mode?: OpenMode) => void;
  /** Footer actions. Routed through the app's existing intent handler so Discard gets the same
   *  confirm dialog the Changes panel uses (D10) — no second destructive path. Settles when the
   *  git work is done, which is what holds Stage all busy. */
  onGitAction?: (intent: GitActionIntent) => Promise<void>;
  onClose: () => void;
  /** What this Review tab is scoped to (working tree vs. a commit). Absent ⇒ working. */
  source?: ReviewSource;
  /** Owning session — scopes the commit-files loader to its repo. */
  sessionId?: string;
  /** The Review doc's session, named for the handoff toast — a Review only shows while its
   *  owning session is active. */
  sessionLabel?: string;
  /** The owning doc id — keys this list's view-state memory (spec 2026-06-30). */
  viewStateId?: string;
  onSetSource: (next: ReviewSource) => void;
  onOpenCompare: () => void;
  /** Which right-pane tab is shown — drives the header panel toggle's state. */
  paneTab: RightPaneTab;
  explorerCollapsed: boolean;
  /** Flips right-pane visibility (the app's `toggleExplorer`). */
  onTogglePanel: () => void;
  /** Selects the Changes tab without persisting it as `rightPaneTab`. */
  onShowChanges: () => void;
}) {
  // Switching tabs unmounts this view (center-pane renders only the active doc), so everything
  // below that must outlive a tab switch is seeded from — and mirrored back to — the store.
  // Acquired into a ref rather than a useMemo: the refs below ALIAS this object, and React
  // documents a memo as a cache it may throw away — a second acquire would hand out a different
  // bag and leave the aliases pointing at the old one.
  const memoryRef = useRef<ReviewListState | null>(null);
  memoryRef.current ??= acquireReviewListState(viewStateId);
  const memory = memoryRef.current;

  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(memory.search.open);
  const [query, setQuery] = useState(memory.search.query);
  const [caseSensitive, setCaseSensitive] = useState(memory.search.caseSensitive);
  const [matchIndex, setMatchIndex] = useState(memory.search.matchIndex);
  const [searchAll, setSearchAll] = useState(memory.search.all);
  const [searchFocus, setSearchFocus] = useState(0);
  const [fileFilter, setFileFilter] = useState(memory.filter);

  const scrollerRef = useRef<HTMLDivElement>(null);

  // Note composer state lives HERE, not in the card: Esc must unwind composer → search → help
  // → Review in that order and `useEscapeKey` listens on window, so the state has to be visible
  // where the unwind is decided (Lane F plan, assumption 12).
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const composerRef = useRef<ComposerTarget | null>(null);
  composerRef.current = composer;
  const composerDirtyRef = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /** The `+` that opened the composer, so focus can return to it on close (§10). */
  const composerOriginRef = useRef<HTMLElement | null>(null);

  const closeComposer = useCallback(() => {
    composerDirtyRef.current = false;
    setComposer(null);
    const origin = composerOriginRef.current;
    composerOriginRef.current = null;
    origin?.focus();
  }, []);

  const requestCloseComposer = useCallback(
    (dirty: boolean) => {
      if (!dirty) {
        closeComposer();
        return;
      }
      setConfirm({
        title: 'Discard this note?',
        message: "It hasn't been saved yet.",
        confirmLabel: 'Discard',
        danger: true,
        focusCancel: true,
        onConfirm: closeComposer,
      });
    },
    [closeComposer],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setSearchAll(false);
    clearReviewHighlights();
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  // Esc unwinds the surface one layer at a time (spec §2 Lane B): search, the help panel, then
  // Review. Read through refs so the window listener isn't re-bound on every toggle, and kept as
  // ONE ordered chain — a second window listener would race this one (Lane F plan, "Lane C
  // collision surface" #4, which inserts the note composer ahead of search).
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  useEscapeKey(
    useCallback(() => {
      if (composerRef.current) {
        requestCloseComposer(composerDirtyRef.current);
        return;
      }
      if (searchOpenRef.current) {
        closeSearch();
        return;
      }
      if (helpOpenRef.current) {
        setHelpOpen(false);
        return;
      }
      onClose();
    }, [onClose, closeSearch, requestCloseComposer]),
  );

  const scope = scopeOfSource(source);
  const openDiffAtScope = useCallback(
    (absPath: string, mode?: OpenMode) => onOpenDiff?.(absPath, scope, mode),
    [onOpenDiff, scope],
  );
  const commitMode = source?.kind === 'commit';
  const rangeMode = source?.kind === 'range';
  // Commit AND range sources both PRELOAD every file's diff (git show / git diff), so the same
  // code path feeds the windowed renderer from a derived list with a no-op on-mount fetch. Only
  // the working source streams per-card. See spec §3.2 + item 4 §A3.
  const preloaded = commitMode || rangeMode;

  // null = All repos: every repo's working tree, grouped (spec 2026-09-23-mf-review §2.1).
  const resolved = resolveReviewRepo(source, reviewRepos, fallbackRoot);
  const grouped = resolved === null;
  const requestRoot = reviewRequestRoot(source, reviewRepos, fallbackRoot);
  // A commit or comparison is about exactly one repo, and its change paths are relative to it.
  const sourceRoot = preloaded ? (source.repoRoot ?? fallbackRoot ?? '') : '';

  // Rules of Hooks: always call both loaders; an inactive one is fed empty args and posts nothing.
  // An unstamped source posts no root, so the host reads the session's own git root as it always has.
  const commit = useCommitFiles(
    sessionId,
    commitMode ? source.sha : '',
    commitMode ? source.repoRoot : undefined,
  );
  const range = useRangeFiles(
    sessionId,
    rangeMode ? source.base : undefined,
    rangeMode ? source.head : undefined,
    rangeMode ? source.repoRoot : undefined,
  );
  const preloadedFiles = commitMode ? commit.files : rangeMode ? range.files : EMPTY_FILES;

  const noopRequestDiff = useCallback(() => {}, []);
  const effectiveDiffs = useMemo(() => {
    if (!preloaded) return diffsForScope(diffs, scope);
    const m = new Map<string, FileDiffDTO>();
    for (const f of preloadedFiles) m.set(reviewFileKey({ repoRoot: sourceRoot, path: f.path }), f);
    return m;
  }, [preloaded, preloadedFiles, diffs, sourceRoot, scope]);
  // Undeduped: Lane D's contract is that a path modified in BOTH the index and the worktree
  // produces two ChangeDTOs, and the staged / conflicted sides are read off both.
  const allChanges = useMemo<ReviewFile[]>(
    () =>
      preloaded
        ? commitChangesFromFiles(preloadedFiles).map((c) => ({ ...c, repoRoot: sourceRoot }))
        : (repoChanges ?? []).flatMap((r) => r.changes.map((c) => ({ ...c, repoRoot: r.root }))),
    [preloaded, preloadedFiles, sourceRoot, repoChanges],
  );
  const effectiveRequestDiff = preloaded ? noopRequestDiff : onRequestDiff;
  const preloadLoading =
    (commitMode && commit.status === 'loading') || (rangeMode && range.status === 'loading');
  const rangeError =
    rangeMode && range.status === 'error' ? (range.error ?? 'Unknown error') : null;
  const commitError =
    commitMode && commit.status === 'error' ? (commit.error ?? 'Unknown error') : null;
  const preloadError = rangeError ?? commitError;
  // A commit/comparison whose file count was capped host-side (spec 2026-07-07-git-host-robustness).
  const truncated = commitMode ? commit.truncated : rangeMode ? range.truncated : undefined;

  // A change can appear twice (staged + unstaged side); review each PATH once per repo. Under a
  // narrowed scope only that side's entries qualify — filtered BEFORE the dedupe, so a path
  // changed on both sides appears in all three scopes with only that side's hunks (§2 Lane D).
  const allFiles = useMemo<ReviewFile[]>(() => {
    if (preloaded) return tagReviewFiles(commitChangesFromFiles(preloadedFiles), sourceRoot);
    const scoped = (repoChanges ?? []).map((r) =>
      scope === 'all' ? r : { ...r, changes: r.changes.filter((c) => inScope(c, scope)) },
    );
    return workingReviewFiles(scoped, resolved);
  }, [preloaded, preloadedFiles, sourceRoot, repoChanges, scope, resolved]);

  // The navigator's path filter narrows the list EVERYTHING downstream is derived from —
  // navigator rows, cards, the windower, the cursor and the search corpus — so there is one
  // notion of "the files on screen" rather than a second filtered view to keep in step (§2 Lane C).
  const files = useMemo(
    () =>
      fileFilter.trim() === ''
        ? allFiles
        : allFiles.filter((c) => fileFilterMatches(c.path, fileFilter)),
    [allFiles, fileFilter],
  );

  // Every per-file key below is the file's ABSOLUTE path (K1): two repos changing the same
  // relative path must never share a card, mark, fold or anchor.
  const fileKeys = useMemo(() => files.map(reviewFileKey), [files]);
  const pathIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < fileKeys.length; i++) m.set(fileKeys[i], i);
    return m;
  }, [fileKeys]);
  // The DOM only carries the repo-relative path plus the folder key (e2e selectors read
  // `data-path`), so a read-back from a card goes through this.
  const fileOfDomKey = useMemo(() => {
    const m = new Map<string, number>();
    files.forEach((f, i) => {
      m.set(cardDomKey(f.repoRoot, f.path), i);
    });
    return m;
  }, [files]);

  // path → real hunk count, reported by the card that computed it. A file the window hasn't
  // mounted has no entry: its change's own +/- counts stand in (Lane B plan, assumption 10). Re-running
  // computeFileReview here for every file would undo the virtualization this list exists for.
  const hunkCountsRef = useRef<Map<string, number>>(new Map());
  const [, setHunkTick] = useState(0);
  const reportHunkCount = useCallback((key: string, count: number) => {
    if (hunkCountsRef.current.get(key) === count) return;
    hunkCountsRef.current.set(key, count);
    setHunkTick((t) => t + 1);
  }, []);

  // Computed inline so it reads the fresh ref on every render, exactly like `win`.
  const fileHunks: ReviewFileHunks[] = files.map((c, i) => ({
    path: fileKeys[i],
    hunkCount: hunkCountsRef.current.get(fileKeys[i]) ?? (c.added + c.removed > 0 ? 1 : 0),
  }));
  const fileHunksRef = useRef(fileHunks);
  fileHunksRef.current = fileHunks;

  // Diffstat header — a pure fold over the deduped file list the cards read (spec §Data). Exact
  // for all three sources; binary files count in `files` with 0 lines.
  const stat = useMemo(() => computeDiffstat(files), [files]);

  // key → measured SLOT height (card border-box + GAP); keyed by path so it survives
  // re-scan/reorder of `changes` (index is not stable, path is). Owned by the store, not by
  // this instance — see ReviewListState.
  const measuredRef = useRef(memory.measured);
  // Per-path card UI (folds, "Show remaining", collapse). Also the store's, same reason.
  const uiCacheRef = useRef(memory.ui);
  // Absolute paths already requested — dedupes a card scrolled out and back (Decision D1).
  // Deliberately NOT persisted across a tab switch: nothing invalidates a diff when the working
  // tree changes under a Review that isn't mounted, so the re-request a remount triggers is what
  // keeps the content honest.
  const requestedRef = useRef<Set<string>>(new Set());
  // Collapsing every card at once invalidates the scroll offset outright. Re-anchor to the file
  // the user was on after each measurement until the offset stops moving — the ResizeObserver
  // reports the new heights over the next frame or two (Lane B plan, assumption 14).
  const keepInViewRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);
  // View-state memory (spec 2026-06-30): in a ref so the [viewKey]-only reset effect can
  // read the id without re-firing on prop re-identity. `scrollRestoredRef` makes restore one-shot;
  // `firstSourceRef` distinguishes the initial mount from a genuine source change (a content reset).
  const viewStateIdRef = useRef(viewStateId);
  viewStateIdRef.current = viewStateId;
  const scrollRestoredRef = useRef(false);
  const firstSourceRef = useRef(true);
  const firstFilterRef = useRef(true);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Bumped purely to force a re-render when a measured height changes (the cache lives in a ref
  // for stable closures, so mutating it doesn't re-render on its own). `win` is recomputed
  // inline below, so the next render reads the fresh cache — otherwise totalHeight + padBottom
  // stay estimate-based until the next scroll and the first scroll jumps.
  const [measureTick, setMeasureTick] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const stagedSide = useMemo(
    () => new Set(allChanges.filter((c) => c.staged).map(reviewFileKey)),
    [allChanges],
  );
  // A conflicted path has no stage-0 index blob to apply against. Under a narrowed scope the
  // card is a notice with no hunks at all; under All it renders normally, so the buttons are
  // what has to say no.
  const conflictedSide = useMemo(
    () => new Set(allChanges.filter((c) => c.conflicted).map(reviewFileKey)),
    [allChanges],
  );
  // Hunk ops exist for the working source only — a commit or a comparison has nothing to stage.
  const hunkOpsAvailable = !preloaded;

  const hunkHost = useSyncExternalStore(
    subscribeHunkActionHost,
    getHunkActionHost,
    getHunkActionHost,
  );

  const runHunkOp = useCallback(
    async (op: HunkOp, change: ReviewFile, hunk: ReviewHunk) => {
      const abs = reviewFileKey(change);
      const lineCount = hunk.lines.filter((l) => l.kind !== 'context').length;
      const shown = effectiveDiffs.get(abs);
      const outcome = await applyHunkAction(
        { host: hunkHost, gitAction, toast: pushToast, announce: setAnnounce },
        {
          op,
          absPath: abs,
          relPath: change.path,
          range: hunkRange(hunk),
          lineCount,
          untracked: change.kind === 'U',
          ...(shown
            ? { expect: { head: contentHash(shown.head), work: contentHash(shown.work) } }
            : {}),
        },
      );
      // The card re-requests its diff: app.tsx dropped the cached entry, and clearing the
      // request-once guard is what lets the card's mount effect ask again (§2 Lane E "the card
      // re-requests its diff"). The reviewed mark prunes itself — Lane B keys it by content hash.
      if (outcome.kind === 'done' || outcome.kind === 'failed') requestedRef.current.delete(abs);
      if (outcome.kind === 'unsupported') setAnnounce(UNTRACKED_DISCARD_TOOLTIP);
    },
    [effectiveDiffs, hunkHost],
  );

  const { settings, update } = useSettings();
  const ignoreWhitespace = settings.reviewIgnoreWhitespace;
  // A navigator click sets this to (target key, bumped nonce); the target card's reveal effect
  // reads the nonce to expand itself even when it was already mounted+collapsed (a fresh mount
  // would seed collapsed from the ui cache, so the cache alone can't re-expand a mounted card).
  // `showAll` additionally lifts the row cap — search reveals a match that may be past it.
  const [reveal, setReveal] = useState<{ path: string; nonce: number; showAll: boolean }>({
    path: '',
    nonce: 0,
    showAll: false,
  });

  // The current hunk: what `j`/`k` move, what the ring marks, and what `m` / `o` act on. `reveal`
  // is bumped ONLY by an explicit move (a key, a header click) — following the scroll anchor must
  // never scroll, or a mouse scroll would fight the reveal below for the viewport.
  const [cursor, setCursor] = useState<{ ref: HunkRef | null; reveal: number }>({
    ref: memory.cursor,
    // Deliberately 0 even for a restored cursor: a non-zero reveal scrolls, which would fight
    // the pre-paint anchor restore for the viewport.
    reveal: 0,
  });
  const current = cursor.ref;

  const navigate = useCallback(
    (step: (list: ReviewFileHunks[], c: HunkRef | null) => HunkRef | null) => {
      setCursor((cur) => ({ ref: step(fileHunksRef.current, cur.ref), reveal: cur.reveal + 1 }));
    },
    [],
  );

  const sourceKey = reviewSourceKey(source);
  // K3: a repo change resets the view like a source change; marks keep the bare sourceKey.
  const viewKey = reviewViewKey(sourceKey, resolved);

  // Drop the per-path caches DURING RENDER rather than in the [viewKey] effect below:
  // effects run child-first, so a card would re-run its request-once effect against the
  // previous scope's dedupe set and never re-fetch.
  //
  // The comparison is against the key the STORE last adopted, never one this instance
  // remembers. Review is a singleton doc (`docs.ts` `openReview`) and the common retarget —
  // "Review this commit" from git history — changes the source AND activates the tab in one
  // dispatch, so the view that must reset is one mounting fresh, with no previous key to compare.
  if (adoptReviewSource(viewStateIdRef.current, viewKey)) {
    requestedRef.current.clear();
    hunkCountsRef.current.clear();
  }

  // Per-file reviewed marks. Durable, host-owned and shared across windows (spec
  // 2026-08-27-review-supercharge §2 Lane B) — this view only reads them and toggles one.
  const marks = useSyncExternalStore(subscribeMarks, getMarksSnapshot, getMarksSnapshot);

  // The receipt a mark is checked against: the new-side text of every file whose diff HAS loaded.
  // A file that isn't loaded has no entry, and is therefore neither reviewed nor stale.
  const hashes = useMemo(() => {
    const m = new Map<string, string>();
    for (const key of fileKeys) {
      const d = effectiveDiffs.get(key);
      if (d) m.set(key, hashOfDiff(d));
    }
    return m;
  }, [fileKeys, effectiveDiffs]);

  // The mark store is per repo and keyed by relative path (K2), so the receipts are regrouped
  // per store root for it.
  const markRoots = useMemo(() => {
    const byRoot = new Map<string, { root: string; hashes: Map<string, string> }>();
    files.forEach((f, i) => {
      const norm = normalizeRoot(f.repoRoot);
      if (norm === '') return;
      let entry = byRoot.get(norm);
      if (!entry) {
        entry = { root: f.repoRoot, hashes: new Map() };
        byRoot.set(norm, entry);
      }
      const h = hashes.get(fileKeys[i]);
      if (h !== undefined) entry.hashes.set(f.path, h);
    });
    return byRoot;
  }, [files, fileKeys, hashes]);

  const reviewed = useMemo(() => {
    const out = new Set<string>();
    for (const [norm, { root, hashes: h }] of markRoots)
      for (const path of reviewedPaths(marks.byRoot.get(norm) ?? EMPTY_MARKS, sourceKey, h))
        out.add(reviewFileKey({ repoRoot: root, path }));
    return out;
  }, [markRoots, marks.byRoot, sourceKey]);

  /** A mark can only be made once we can hash what is being marked (Lane B plan, assumption 8). */
  const canMark = useCallback(
    (f: ReviewFile) => marks.loaded && f.repoRoot !== '' && hashes.has(reviewFileKey(f)),
    [marks.loaded, hashes],
  );

  const onToggleReviewed = useCallback(
    (f: ReviewFile) => {
      const key = reviewFileKey(f);
      const hash = hashes.get(key);
      if (!canMark(f) || hash === undefined) {
        // The control is disabled, but `m` reaches this path from the keyboard too.
        if (marks.loaded && f.repoRoot !== '') setAnnounce(`Still loading the diff for ${f.path}`);
        return;
      }
      const on = !reviewed.has(key);
      setReviewMark(
        normalizeRoot(f.repoRoot),
        { source: sourceKey, path: f.path, contentHash: hash, at: new Date().toISOString() },
        on,
      );
      setAnnounce(on ? `Marked ${f.path} reviewed` : `Unmarked ${f.path}`);
    },
    [hashes, canMark, reviewed, sourceKey, marks.loaded],
  );

  // A mark whose file has changed since is RETIRED, not merely hidden (§2 Lane B). The host has
  // no file text, so the side that can tell is the one that does it.
  useEffect(() => {
    if (!marks.loaded) return;
    for (const [norm, { hashes: h }] of markRoots)
      for (const m of staleMarks(marks.byRoot.get(norm) ?? EMPTY_MARKS, sourceKey, h))
        setReviewMark(norm, m, false);
  }, [marks.loaded, marks.byRoot, markRoots, sourceKey]);

  // Per-repo review notes. Durable, host-owned, shared across windows and readable by the
  // agent (spec §2 Lane F); this view reads them and sends one patch at a time.
  const notesSnapshot = useSyncExternalStore(subscribeNotes, getNotesSnapshot, getNotesSnapshot);
  // store root → the root's own bytes (file keys are built from those). All repos reads every
  // repo in the session, so a repo with notes but no listed file still reaches the handoff (§3.3).
  const noteRoots = useMemo(() => {
    const out = new Map<string, string>();
    const add = (root: string) => {
      const norm = normalizeRoot(root);
      if (norm !== '' && !out.has(norm)) out.set(norm, root);
    };
    for (const f of files) add(f.repoRoot);
    if (grouped) for (const r of reviewRepos) add(r.root);
    else add(preloaded ? sourceRoot : resolved);
    return out;
  }, [files, grouped, reviewRepos, preloaded, sourceRoot, resolved]);
  const noteRootsKey = [...noteRoots.keys()].join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined key is the identity of the root set.
  useEffect(() => {
    for (const norm of noteRoots.keys()) loadNotesFor(norm);
  }, [noteRootsKey]);

  const repoNotes = useMemo(
    () => [...noteRoots.keys()].flatMap((norm) => notesFor(notesSnapshot, norm)),
    [noteRoots, notesSnapshot],
  );
  const notesReady =
    noteRoots.size > 0 && [...noteRoots.keys()].every((norm) => notesLoaded(notesSnapshot, norm));
  // A thread only reports its note's id; the repo it lives in is looked up here.
  const noteRootOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const norm of noteRoots.keys())
      for (const n of notesFor(notesSnapshot, norm)) m.set(n.id, norm);
    return m;
  }, [noteRoots, notesSnapshot]);

  const notesByKey = useMemo(() => {
    const m = new Map<string, ReviewNote[]>();
    for (const [norm, root] of noteRoots) {
      for (const n of notesFor(notesSnapshot, norm)) {
        const key = reviewFileKey({ repoRoot: root, path: n.path });
        const list = m.get(key);
        if (list) list.push(n);
        else m.set(key, [n]);
      }
    }
    return m;
  }, [noteRoots, notesSnapshot]);

  // Evaluated per card repo: one repo at its cap must not refuse notes in another (§4).
  const refusedFor = (root: string): string | undefined =>
    canAddNote(notesFor(notesSnapshot, normalizeRoot(root))) ? undefined : NOTE_CAP_MESSAGE;

  const openComposer = useCallback(
    (
      key: string,
      side: NoteSide,
      line: number,
      snippet: string,
      anchor: string,
      origin?: HTMLElement,
    ) => {
      const i = pathIndex.get(key);
      const f = i === undefined ? undefined : files[i];
      if (!f || f.repoRoot === '' || !notesLoaded(notesSnapshot, normalizeRoot(f.repoRoot))) {
        setAnnounce('Still loading notes for this repository');
        return;
      }
      composerOriginRef.current = origin ?? null;
      composerDirtyRef.current = false;
      setComposer({ key, root: f.repoRoot, path: f.path, side, line, snippet, anchor });
    },
    [pathIndex, files, notesSnapshot],
  );

  const saveNote = useCallback(
    (body: string) => {
      const target = composerRef.current;
      if (!target) return;
      const norm = normalizeRoot(target.root);
      // `applyNotePatch` is the one authority on whether an add lands (the open-note cap, an
      // over-long body). Announcing "Note added" before asking it would tell a screen reader the
      // opposite of what happened.
      if (!canAddNote(notesFor(notesSnapshot, norm))) {
        setAnnounce(NOTE_CAP_MESSAGE);
        return;
      }
      patchNotes(norm, {
        op: 'add',
        note: {
          id: newNoteId(),
          path: target.path,
          side: target.side,
          line: target.line,
          anchor: target.anchor,
          snippet: target.snippet,
          body,
          createdAt: new Date().toISOString(),
        },
      });
      setAnnounce(`Note added on line ${target.line} of ${target.path}`);
      closeComposer();
    },
    [notesSnapshot, closeComposer],
  );

  const editNote = useCallback(
    (id: string, body: string) => {
      const norm = noteRootOf.get(id);
      if (norm) patchNotes(norm, { op: 'edit', id, body });
    },
    [noteRootOf],
  );

  const resolveNote = useCallback(
    (id: string, resolved: boolean) => {
      const norm = noteRootOf.get(id);
      if (!norm) return;
      patchNotes(norm, { op: 'resolve', id, resolved, at: new Date().toISOString() });
      setAnnounce(resolved ? 'Note resolved' : 'Note reopened');
    },
    [noteRootOf],
  );

  // Destructive, so it confirms — the same dialog the Changes panel uses (D10).
  const deleteNote = useCallback(
    (note: ReviewNote) => {
      const norm = noteRootOf.get(note.id);
      if (!norm) return;
      setConfirm({
        title: 'Delete this note?',
        message: `The note on line ${note.line} of ${note.path} will be removed. This can’t be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        focusCancel: true,
        onConfirm: () => {
          patchNotes(norm, { op: 'delete', id: note.id });
          setAnnounce('Note deleted');
        },
      });
    },
    [noteRootOf],
  );

  const onComposerDirty = useCallback((dirty: boolean) => {
    composerDirtyRef.current = dirty;
  }, []);

  const pending = useMemo(() => pendingNotes(repoNotes), [repoNotes]);

  // Re-anchored before it is handed over. `reanchor` is view-only and never rewrites the stored
  // `note.line` (plan assumption 4), so a note written before an edit above it still carries its
  // ORIGINAL line — and the agent would be sent to the wrong place. A file whose diff has not
  // loaded has nothing to anchor against, so its notes go over on their stored line.
  const pendingByRoot = useMemo(() => {
    const out = new Map<string, AnchoredNote[]>();
    for (const [norm, root] of noteRoots) {
      const byPath = new Map<string, ReviewNote[]>();
      for (const n of pendingNotes(notesFor(notesSnapshot, norm))) {
        const list = byPath.get(n.path);
        if (list) list.push(n);
        else byPath.set(n.path, [n]);
      }
      const anchored: AnchoredNote[] = [];
      for (const [path, list] of byPath) {
        const diff = effectiveDiffs.get(reviewFileKey({ repoRoot: root, path }));
        if (!diff || diff.binary) {
          for (const note of list) anchored.push({ note, line: note.line });
          continue;
        }
        const newLines = diff.work.split('\n');
        const oldLines = diff.head.split('\n');
        anchored.push(
          ...reanchor(
            list.filter((n) => n.side === 'new'),
            newLines,
          ),
          ...reanchor(
            list.filter((n) => n.side === 'old'),
            oldLines,
          ),
        );
      }
      if (anchored.length > 0) out.set(norm, anchored);
    }
    return out;
  }, [noteRoots, notesSnapshot, effectiveDiffs]);
  // A terminal can register or go away between renders and neither is a state update here, so
  // the bus's version counter is what re-renders this control (terminal-bus.ts).
  useSyncExternalStore(subscribeTerminalBus, getTerminalBusVersion, getTerminalBusVersion);
  const handoffLive = sessionId ? hasLiveTerminal(sessionId) : false;
  const handoff = handoffLabel(pending.length, handoffLive);
  const handoffHintId = useId();

  const sourceLabel =
    source?.kind === 'commit'
      ? `commit ${source.sha.slice(0, 7)}`
      : source?.kind === 'range'
        ? `${endpointLabel(source.base)}…${endpointLabel(source.head)}`
        : scope === 'all'
          ? 'working tree'
          : `${SCOPE_LABEL[scope].toLowerCase()} changes`;

  // Group structure for All repos (spec §2.4). File indices are contiguous per group by
  // construction: workingReviewFiles emits in repo order and grouping keeps input order.
  const groups = useMemo(
    () => (grouped ? groupReviewFiles(files, repoChanges ?? [], reviewed) : NO_GROUPS),
    [grouped, files, repoChanges, reviewed],
  );
  const list = useMemo(
    () => reviewListItems(grouped ? groups.map((g) => g.files.length) : null, files.length),
    [grouped, groups, files.length],
  );
  const itemCount = list.items.length;
  const itemKeys = useMemo(
    () =>
      list.items.map((it) =>
        it.kind === 'file' ? fileKeys[it.fileIndex] : `\u0001${groups[it.groupIndex].root}`,
      ),
    [list, fileKeys, groups],
  );
  const itemIndexOfKey = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < itemKeys.length; i++) m.set(itemKeys[i], i);
    return m;
  }, [itemKeys]);
  const indexOfKey = useCallback((key: string) => itemIndexOfKey.get(key), [itemIndexOfKey]);

  const onHandoff = useCallback(() => {
    if (pending.length === 0) return;
    const contributing: string[] = [];
    let md: string;
    if (grouped) {
      const repos: HandoffRepo[] = [];
      for (const r of reviewRepos) {
        const norm = normalizeRoot(r.root);
        const notes = pendingByRoot.get(norm);
        if (!notes) continue;
        contributing.push(norm);
        const key = folderKey(r.root);
        const group = groups.find((g) => folderKey(g.root) === key);
        const name = repoChanges?.find((c) => folderKey(c.root) === key)?.name;
        repos.push({
          name: name ?? repoBaseName(r.root),
          pathPrefix: handoffPathPrefix(r.root, home ?? r.root),
          notes,
          files: group ? group.files.map((f) => f.path) : [],
        });
      }
      md = buildGroupedHandoffMarkdown(repos, sourceLabel);
    } else {
      const norm = [...pendingByRoot.keys()][0];
      if (norm === undefined) return;
      contributing.push(norm);
      md = buildHandoffMarkdown(
        pendingByRoot.get(norm) ?? [],
        files.map((f) => f.path),
        sourceLabel,
      );
    }
    const plural = pending.length === 1 ? '' : 's';
    const stamp = () => {
      const at = new Date().toISOString();
      for (const norm of contributing)
        patchNotes(norm, {
          op: 'sent',
          ids: pendingNotes(notesFor(notesSnapshot, norm)).map((n) => n.id),
          at,
        });
      setAnnounce(`Sent ${pending.length} note${plural}`);
    };

    if (sessionId && pasteToTerminal(sessionId, md)) {
      stamp();
      // Deliberately no view switch and no Enter (§2 Lane F): the user must read what reached
      // the agent, and yanking them out of a half-read review is the worse failure.
      pushToast({
        message: `Sent ${pending.length} note${plural} to ${sessionLabel ?? 'the session'}`,
        variant: 'info',
      });
      return;
    }

    navigator.clipboard
      .writeText(md)
      .then(() => {
        stamp();
        pushToast({
          message: `Copied ${pending.length} note${plural} as markdown`,
          variant: 'info',
        });
      })
      .catch(() => {
        pushToast({ message: 'Copy failed: the clipboard is unavailable.', variant: 'error' });
      });
  }, [
    pending,
    pendingByRoot,
    grouped,
    reviewRepos,
    groups,
    repoChanges,
    home,
    files,
    sourceLabel,
    notesSnapshot,
    sessionId,
    sessionLabel,
  ]);

  // Capture the top-visible card anchor (computed live on scroll into a ref) so the final
  // unmount flush never reads a detached scroller. Debounced live capture (§3 / D5).
  const lastAnchorRef = useRef<{ topPath: string; offset: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const id = viewStateIdRef.current;
    if (id && lastAnchorRef.current) mergeReviewViewState(id, { anchor: lastAnchorRef.current });
  }, []);
  const { schedule: scheduleAnchorCapture, cancel: cancelAnchorCapture } = useDebouncedFlush(
    captureAnchor,
    VIEW_STATE_DEBOUNCE_MS,
  );

  // Reset scroll + focus when the SOURCE (or the repo, K3) changes so a stale offset can't strand
  // the user mid-list, and announce the new source to SR users (spec §4 + §10). The anchor and the
  // per-path caches were dropped by `adoptReviewSource` in the render phase; the cards holding
  // a copy of that per-path state are re-keyed on `viewKey`, so they remount and re-seed.
  const prevSourceKeyRef = useRef(sourceKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: must fire only on a view CHANGE (viewKey), not when the referenced setters/source re-identify; see spec §4.
  useEffect(() => {
    const repoOnly = prevSourceKeyRef.current === sourceKey && !firstSourceRef.current;
    prevSourceKeyRef.current = sourceKey;
    if (repoOnly) {
      setAnnounce(
        resolved === null
          ? `Reviewing all ${reviewRepos.length} repos`
          : `Reviewing ${repoChipLabel(reviewRepos, resolved)}`,
      );
    } else {
      const label = reviewSourceLabel(source).replace(/^Reviewing /, 'reviewing ');
      setAnnounce(`Now ${label}${scope === 'all' ? '' : ` — ${SCOPE_LABEL[scope]} only`}`);
    }
    // A mount is not a source change — there is no stale offset to clear, and the restore below
    // is what owns the offset on the way in.
    if (firstSourceRef.current) {
      firstSourceRef.current = false;
      return;
    }
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
    setFocusedPath(null);
    scrollRestoredRef.current = true;
    // A capture scheduled just before the change would fire after it and write the OLD anchor
    // back over the reset — invisible this mount, but it is what the next remount would restore.
    cancelAnchorCapture();
    lastAnchorRef.current = null;
    // The chip's menu hands focus back to the chip as it closes; a repo change moves on to the
    // list it just changed (spec §10).
    if (repoOnly) el?.focus({ preventScroll: true });
  }, [viewKey]);

  // A narrowed repo that leaves the session falls back to All repos (spec §4 "repo leaves").
  // Declared after the reset effect so, in the commit that drops the repo, its announcement is
  // the one that stands.
  const staleRoot = isStaleWorkingRoot(source, reviewRepos);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stale flag is the trigger.
  useEffect(() => {
    if (!staleRoot || source?.kind !== 'working' || source.repoRoot === undefined) return;
    setAnnounce(
      `${repoBaseName(source.repoRoot)} is no longer in this session — showing all repos`,
    );
    onSetSource(workingSource(scope));
  }, [staleRoot]);

  // Narrowing the file filter shortens the list under the scroller; a kept offset would strand
  // the user below the new content. Same reset the source change does, for the same reason —
  // and the same mount exemption, since a restored filter is not a change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is the trigger.
  useEffect(() => {
    if (firstFilterRef.current) {
      firstFilterRef.current = false;
      return;
    }
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [fileFilter]);

  const estimateSlot = useCallback(
    (c: ChangeDTO) => estimateCardHeight(c.added, c.removed) + GAP,
    [],
  );
  // Window items are group headers and cards (spec §2.4); a header is one fixed, unmeasured height.
  const heightOf = useCallback(
    (i: number) => {
      const it = list.items[i];
      if (it.kind === 'group') return REVIEW_GROUP_HEAD_H;
      return measuredRef.current.get(fileKeys[it.fileIndex]) ?? estimateSlot(files[it.fileIndex]);
    },
    [list, fileKeys, files, estimateSlot],
  );

  // Restore the saved anchor BEFORE the first paint, or the list paints at the top and then jumps
  // (CLAUDE.md's "apply the fit before first paint"). A LAYOUT effect is what makes that true:
  // `viewportHeight` is still 0 on the first committed frame, and until it is measured the
  // windower mounts no cards and renders no spacers — so the scroller has no height to scroll
  // and any offset written now would clamp to 0. Measuring it is itself a layout effect, so its
  // state update re-runs this one in the same pre-paint pass — which is what makes the restore
  // pre-paint, and why `test/unit/review-restore-prepaint.test.ts` guards BOTH effects. The
  // guarantee covers the mount path only: a pane that starts at zero height (a hidden or
  // zero-sized container) is measured later by the ResizeObserver, whose callback is outside
  // React's batching, so that restore lands after a paint. Rare, and it beats not restoring.
  // The anchor is resolved rather than replayed as raw px because a card's slot height depends on
  // its folds and row cap; `resolveReviewAnchor` reads the same restored height table.
  useLayoutEffect(() => {
    if (scrollRestoredRef.current) return;
    const el = scrollerRef.current;
    const id = viewStateIdRef.current;
    if (!el || !id || files.length === 0 || viewportHeight === 0) return;
    scrollRestoredRef.current = true;
    const saved = getViewState(id);
    if (saved?.kind !== 'reviewAnchor' || saved.topPath === '') return;
    const top = resolveReviewAnchor(saved, itemCount, heightOf, indexOfKey);
    el.scrollTop = top;
    setScrollTop(top);
  }, [files.length, itemCount, viewportHeight, heightOf, indexOfKey]);

  // Navigator click → scroll a file's card to the top of the viewport. Routed through the SAME
  // offset math the windower/anchor use (resolveReviewAnchor sums heightOf up to the target), so
  // setting scrollTop mounts + positions the card; the reveal nonce expands it if collapsed.
  const scrollToFile = useCallback(
    (key: string, showAll = false) => {
      const el = scrollerRef.current;
      if (!el || itemIndexOfKey.get(key) === undefined) return;
      const top = resolveReviewAnchor({ topPath: key, offset: 0 }, itemCount, heightOf, indexOfKey);
      // An explicit jump supersedes a pending "keep this file in view" anchor from a bulk
      // collapse: otherwise the next measurement drags the scroller straight back (onMeasure).
      keepInViewRef.current = null;
      el.scrollTop = top;
      setScrollTop(top);
      setReveal((r) => ({ path: key, nonce: r.nonce + 1, showAll }));
    },
    [itemCount, heightOf, itemIndexOfKey, indexOfKey],
  );

  // Computed inline (not memoized): heightOf reads the measured-height cache through a ref, so
  // memoizing on stable deps would miss measurement updates. computeWindow is O(count) and pure;
  // re-running it each render keeps the spacers honest for the cost of a cheap index walk.
  const win = computeWindow({
    count: itemCount,
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
    const fi = focusedPath ? (itemIndexOfKey.get(focusedPath) ?? -1) : -1;
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
  }, [win, focusedPath, itemIndexOfKey, heightOf]);

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
    (key: string, cardHeight: number) => {
      const slot = cardHeight + GAP;
      const fi = pathIndex.get(key);
      if (fi === undefined) return;
      const prev = measuredRef.current.get(key) ?? estimateSlot(files[fi]);
      if (measuredRef.current.get(key) === slot) return;
      measuredRef.current.set(key, slot);

      // Scroll anchoring: if a card ABOVE the top-most visible item changes height, shift the
      // scroller by the delta so the content under the viewport stays put (no jump).
      const el = scrollerRef.current;
      const idx = itemIndexOfKey.get(key);
      if (el && idx !== undefined) {
        let offset = 0;
        let topVisible = itemCount;
        for (let i = 0; i < itemCount; i++) {
          const h = heightOf(i);
          if (offset + h > el.scrollTop) {
            topVisible = i;
            break;
          }
          offset += h;
        }
        if (idx < topVisible) el.scrollTop += slot - prev;
      }

      const keep = keepInViewRef.current;
      if (keep !== null && el) {
        const want = resolveReviewAnchor(
          { topPath: keep, offset: 0 },
          itemCount,
          heightOf,
          indexOfKey,
        );
        if (Math.abs(el.scrollTop - want) > 1) {
          el.scrollTop = want;
          setScrollTop(want);
        } else {
          keepInViewRef.current = null;
        }
      }
      setMeasureTick((t) => t + 1);
    },
    [files, pathIndex, itemIndexOfKey, itemCount, estimateSlot, heightOf, indexOfKey],
  );

  // Request-once diff fetch: a card requests its diff when it mounts (enters the window) if
  // not already requested. Only windowed cards mount, so in-flight fetches are bounded by the
  // window size — no explicit concurrency cap needed (Decision D1).
  const requestOnce = useCallback(
    (abs: string) => {
      if (requestedRef.current.has(abs)) return;
      requestedRef.current.add(abs);
      effectiveRequestDiff(abs, scope);
    },
    [effectiveRequestDiff, scope],
  );
  const retryDiff = useCallback(
    (abs: string) => {
      requestedRef.current.delete(abs);
      requestOnce(abs);
    },
    [requestOnce],
  );

  const setCardUi = useCallback((key: string, next: CardUiState) => {
    uiCacheRef.current.set(key, next);
  }, []);

  // A bulk toggle has to reach cards the window hasn't mounted, so it writes the per-path cache
  // (which a fresh mount seeds from) AND bumps a nonce the mounted cards react to.
  const [bulk, setBulk] = useState<{ collapsed: boolean; nonce: number }>(memory.bulk);

  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      for (const key of fileKeys) {
        const prev = uiCacheRef.current.get(key) ?? emptyUi(collapsed);
        uiCacheRef.current.set(key, { ...prev, collapsed });
      }
      keepInViewRef.current = activePathRef.current;
      setBulk((b) => ({ collapsed, nonce: b.nonce + 1 }));
      setAnnounce(collapsed ? 'Collapsed every file' : 'Expanded every file');
    },
    [fileKeys],
  );

  // The two caches above ARE the store's own objects, but React state cannot be aliased —
  // so the rest of the tab's memory is mirrored after every render. Unconditional on purpose:
  // a dependency list here is one more thing that can fall behind what the user last did.
  useEffect(() => {
    memory.bulk = bulk;
    memory.filter = fileFilter;
    memory.cursor = cursor.ref;
    memory.search = { open: searchOpen, query, caseSensitive, all: searchAll, matchIndex };
  });

  const mounted: ReviewListItem[] =
    view.endIndex >= view.startIndex ? list.items.slice(view.startIndex, view.endIndex + 1) : [];
  const mountedFiles: ReviewFile[] = [];
  for (const it of mounted) if (it.kind === 'file') mountedFiles.push(files[it.fileIndex]);
  const firstShown = mounted.length > 0 ? fileAtOrAfter(list, view.startIndex) : -1;
  const lastShownItem = mounted.findLast((it) => it.kind === 'file');
  const lastShown = lastShownItem?.kind === 'file' ? lastShownItem.fileIndex : -1;

  // Announce large window jumps to SR users (the off-window cards aren't in the AT tree).
  const lastAnnouncedRef = useRef(-ANNOUNCE_THRESHOLD);
  useEffect(() => {
    if (files.length === 0 || firstShown < 0 || lastShown < 0) return;
    if (Math.abs(firstShown - lastAnnouncedRef.current) < ANNOUNCE_THRESHOLD) return;
    lastAnnouncedRef.current = firstShown;
    setAnnounce(`Showing files ${firstShown + 1}–${lastShown + 1} of ${files.length}`);
  }, [firstShown, lastShown, files.length]);

  // Dev/test perf hook — read by the load-test e2e. Just numbers; cheap enough to attach
  // unconditionally (mirrors webview/log.ts's window.__conduitLog seam).
  const mountedCardCount = mountedFiles.length;
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

  const onFocusCapture = useCallback(
    (e: ReactFocusEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.rcard');
      if (!card) return;
      const i = fileOfDomKey.get(cardDomKey(card.dataset.root ?? '', card.dataset.path ?? ''));
      if (i !== undefined) setFocusedPath(fileKeys[i]);
    },
    [fileOfDomKey, fileKeys],
  );
  const onBlurCapture = useCallback((e: ReactFocusEvent) => {
    if (!scrollerRef.current?.contains(e.relatedTarget as Node | null)) setFocusedPath(null);
  }, []);

  const anyInFlight = mountedFiles.some((f) => !effectiveDiffs.get(reviewFileKey(f)));

  // ── Search in diff (spec §2 Lane C) ────────────────────────────────────────────────────────
  // The corpus is the LOADED FileReview data, never the DOM: a collapsed card, a row past the
  // 40-row cap and a card the windower hasn't mounted all hold matches the user must reach.
  const searchFiles = useMemo<ReviewSearchFile[]>(() => {
    if (!searchOpen) return NO_SEARCH_FILES;
    return fileKeys.map((key) => {
      const d = effectiveDiffs.get(key);
      return { path: key, review: d ? (reviewOfDiff(d, ignoreWhitespace) ?? NO_HUNKS) : null };
    });
  }, [searchOpen, fileKeys, effectiveDiffs, ignoreWhitespace]);

  const results = useMemo(
    () => collectMatches(searchFiles, query, { caseSensitive }),
    [searchFiles, query, caseSensitive],
  );
  // Clamped on read rather than in an effect: a diff arriving mid-search shortens nothing, but a
  // narrowed file filter can, and a one-render-stale ordinal would paint the wrong current match.
  const currentMatch =
    results.matches.length === 0 ? -1 : Math.min(matchIndex, results.matches.length - 1);

  const matchesByPath = useMemo(() => {
    const m = new Map<string, { index: number; match: ReviewMatch }[]>();
    results.matches.forEach((match, index) => {
      const list = m.get(match.path);
      if (list) list.push({ index, match });
      else m.set(match.path, [{ index, match }]);
    });
    return m;
  }, [results]);

  // A NEW query starts at the first match; a diff arriving under "Search all files" must not
  // move the cursor, which is why this is keyed to the query and not to the result set.
  const queryKey = `${caseSensitive ? 'S' : 'i'}\u0000${query}`;
  const firstQueryRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger.
  useEffect(() => {
    // A restored query is not a new one — zeroing on mount would drop the match the user was on.
    if (firstQueryRef.current) {
      firstQueryRef.current = false;
      return;
    }
    setMatchIndex(0);
  }, [queryKey]);

  const cardSelectorOf = useCallback(
    (key: string): string | null => {
      const i = pathIndex.get(key);
      return i === undefined ? null : cardSelector(files[i]);
    },
    [pathIndex, files],
  );

  // No height-cache invalidation here (the Lane F plan's "Lane C collision surface" #6 expects a
  // shared `invalidateHeight`): expanding a card or lifting its cap resizes it, so the card's own
  // ResizeObserver re-reports through `onMeasure`. A bare delete would be worse than nothing —
  // nothing else fires, so the entry would never come back and the slot would stay on its estimate.
  const [rowTarget, setRowTarget] = useState({ path: '', seq: -1, nonce: 0 });
  const revealMatch = useCallback(
    (m: ReviewMatch) => {
      scrollToFile(m.path, true);
      setRowTarget((t) => ({ path: m.path, seq: m.seq, nonce: t.nonce + 1 }));
    },
    [scrollToFile],
  );

  // Locate the row by `data-seq`, never by index × row height: folds, the cap and (Lane F) note
  // rows all interleave non-diff rows into the card (Lane F plan, collision surface #1).
  const rowRevealedRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window/measure ticks are the "has the row mounted yet" trigger.
  useLayoutEffect(() => {
    if (rowTarget.nonce === 0 || rowRevealedRef.current === rowTarget.nonce) return;
    const sel = cardSelectorOf(rowTarget.path);
    const row = sel
      ? scrollerRef.current?.querySelector<HTMLElement>(
          `${sel} .rline[data-seq="${rowTarget.seq}"]`,
        )
      : null;
    if (!row) return;
    rowRevealedRef.current = rowTarget.nonce;
    row.scrollIntoView({ block: 'center' });
  }, [rowTarget, view.startIndex, view.endIndex, measureTick]);

  // Typing deliberately does NOT scroll: a reveal expands collapsed cards and lifts row caps,
  // which is far too much work to redo on every keystroke. So the first Enter on a query lands
  // on the match the count already points at, and only then does Enter step.
  const revealedQueryRef = useRef<string | null>(null);
  const stepSearch = useCallback(
    (dir: 1 | -1) => {
      const n = results.matches.length;
      if (n === 0) return;
      const from = currentMatch < 0 ? 0 : currentMatch;
      const next = revealedQueryRef.current === queryKey ? stepMatch(from, n, dir) : from;
      revealedQueryRef.current = queryKey;
      setMatchIndex(next);
      revealMatch(results.matches[next]);
    },
    [currentMatch, queryKey, results, revealMatch],
  );

  // Repainted after EVERY render: a card mounting, a fold opening or the cap lifting all change
  // which rows exist, and none of them is a dependency this effect could name. Cost is bounded
  // by the mounted cards' own matches, not by the (up to 2000) match list.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !highlightApiAvailable()) return;
    if (!searchOpen || results.matches.length === 0) {
      clearReviewHighlights();
      return;
    }
    const all: Range[] = [];
    let current: Range | null = null;
    for (const c of mountedFiles) {
      const card = el.querySelector(cardSelector(c));
      if (!card) continue;
      for (const { index, match } of matchesByPath.get(reviewFileKey(c)) ?? []) {
        const text = card.querySelector(`.rline[data-seq="${match.seq}"] .rline__text`);
        if (!text) continue;
        const range = rangeInRowText(text, match.start, match.end);
        if (!range) continue;
        if (index === currentMatch) current = range;
        else all.push(range);
      }
    }
    paintReviewHighlights(all, current);
  });

  useEffect(() => clearReviewHighlights, []);

  // "Search all files": the working source streams per card, so the rest of the changeset is
  // pulled through the SAME request-once loader, batched by arrivals rather than fired at once.
  useEffect(() => {
    if (!searchAll) return;
    const pending = fileKeys.filter((key) => !effectiveDiffs.has(key));
    if (pending.length === 0) {
      setSearchAll(false);
      return;
    }
    for (const key of pending.slice(0, SEARCH_ALL_BATCH)) requestOnce(key);
  }, [searchAll, fileKeys, effectiveDiffs, requestOnce]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
  }, []);

  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch();
    else openSearch();
  }, [searchOpen, closeSearch, openSearch]);

  // The navigator highlights the file nearest the viewport top — derived from the SAME anchor
  // math the scroll-memory uses (no new observer). Null before the list/viewport are measured.
  // A group header at the top stands for its first file.
  const anchorTop =
    itemCount > 0 ? computeReviewAnchor(scrollTop, itemCount, heightOf, (i) => itemKeys[i]) : null;
  const anchorItem = anchorTop ? (itemIndexOfKey.get(anchorTop.topPath) ?? -1) : -1;
  const activeIndex = anchorItem >= 0 ? fileAtOrAfter(list, anchorItem) : -1;
  const activeKey = activeIndex >= 0 ? fileKeys[activeIndex] : null;
  activePathRef.current = activeKey;

  // Scrolling is how the user says "I'm looking at this file now" — the ring follows, or the next
  // `j` would jump back to wherever they last pressed a key. `reveal` is deliberately untouched.
  useEffect(() => {
    setCursor((cur) => ({ ...cur, ref: syncToAnchor(cur.ref, fileHunksRef.current, activeIndex) }));
  }, [activeIndex]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a file-list change is the trigger; the list itself is read live.
  useEffect(() => {
    setCursor((cur) => ({ ...cur, ref: clampRef(cur.ref, fileHunksRef.current) }));
  }, [files.length]);

  // A staged or discarded hunk shortens ONE file without changing the file count, so the
  // cursor has to be brought back inside the list on the hunk count too (§2 Lane E).
  const hunkCountKey = useMemo(() => fileHunks.map((f) => f.hunkCount).join(','), [fileHunks]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger; the list itself is read live.
  useEffect(() => {
    setCursor((cur) => ({ ...cur, ref: clampRef(cur.ref, fileHunksRef.current) }));
  }, [hunkCountKey]);

  const currentFile = current ? files[current.fileIndex] : undefined;
  const currentPath = currentFile ? reviewFileKey(currentFile) : null;

  // The last reveal this effect actually landed. A card outside the window isn't in the DOM yet, so
  // the first pass only scrolls to it and the effect re-runs once the window change mounts it —
  // hence the window deps, and hence this guard, so an unrelated window change can't re-fire a
  // reveal that already happened and steal focus back.
  const revealedRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: view.startIndex/endIndex are the "did the card mount yet" trigger.
  useLayoutEffect(() => {
    if (cursor.reveal === 0 || revealedRef.current === cursor.reveal) return;
    if (!current || !currentFile || !currentPath) return;
    const card = scrollerRef.current?.querySelector<HTMLElement>(cardSelector(currentFile));
    if (!card) {
      scrollToFile(currentPath);
      return;
    }
    const target =
      current.hunkIndex >= 0
        ? card.querySelector<HTMLElement>(`.rhunk__jump[data-hunk="${current.hunkIndex}"]`)
        : card.querySelector<HTMLElement>('.rcard__toggle');
    if (!target) return;
    revealedRef.current = cursor.reveal;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [
    cursor.reveal,
    current,
    currentFile,
    currentPath,
    scrollToFile,
    view.startIndex,
    view.endIndex,
  ]);

  // A clicked header is already on screen, so this moves the ring WITHOUT bumping `reveal` —
  // scrolling to what the user just clicked would only jerk the viewport.
  const setCurrentFromCard = useCallback(
    (key: string, hunkIndex: number) => {
      const fileIndex = pathIndex.get(key);
      if (fileIndex !== undefined) setCursor((cur) => ({ ...cur, ref: { fileIndex, hunkIndex } }));
    },
    [pathIndex],
  );

  // A glyph click in the editor asked for THIS note; app.tsx opened Review, this lands on it.
  const noteTarget = useSyncExternalStore(subscribeNoteTarget, getNoteTarget, getNoteTarget);
  const landedNonceRef = useRef(0);
  useEffect(() => {
    if (!noteTarget || landedNonceRef.current === noteTarget.nonce) return;
    // Not in this changeset — leave the user where they are rather than scrolling nowhere.
    const i = fileOfDomKey.get(cardDomKey(noteTarget.root, noteTarget.path));
    if (i === undefined) return;
    landedNonceRef.current = noteTarget.nonce;
    scrollToFile(fileKeys[i]);
    setAnnounce(`Opened the note on line ${noteTarget.line} of ${noteTarget.path}`);
  }, [noteTarget, fileOfDomKey, fileKeys, scrollToFile]);

  const jumpToCurrent = useCallback(() => {
    if (!current || !currentFile) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `${cardSelector(currentFile)} .rhunk__jump[data-hunk="${current.hunkIndex}"]`,
    );
    // The header button already knows its own work line; clicking it is the same path a mouse takes.
    el?.click();
  }, [current, currentFile]);

  // `s` runs whichever primary action the header is actually showing; binding it to a button
  // that is not on screen would be worse than binding it to the one that is (Lane E plan, 14).
  const runCurrentHunkOp = useCallback(
    (op: HunkOp) => {
      if (!current || current.hunkIndex < 0 || !currentFile) return;
      const key = reviewFileKey(currentFile);
      const diff = effectiveDiffs.get(key);
      if (!diff) return;
      // The SAME hunks the card renders, or the index this ref names is not the hunk the user
      // is looking at.
      const hunk = reviewOfDiff(diff, ignoreWhitespace)?.hunks[current.hunkIndex];
      if (!hunk) return;
      if (!hunkOpsAvailable) {
        setAnnounce(NO_HUNK_OPS_TOOLTIP);
        return;
      }
      const mode = hunkButtonMode(
        scope,
        stagedSide.has(key),
        conflictedSide.has(key) || diff.unmerged === true,
        ignoreWhitespace,
      );
      if (mode === 'blocked' || mode === 'unmerged' || mode === 'whitespace') {
        setAnnounce(blockedReason(mode));
        return;
      }
      if (op === 'discardHunk' && (mode === 'unstage' || currentFile.kind === 'U')) {
        setAnnounce(discardTitle(mode, currentFile.kind === 'U'));
        return;
      }
      // `s` means "the primary action this header is showing", so the mode rule is applied HERE
      // and nowhere else — the switch below stays a plain key→op mapping.
      const effective = op === 'stageHunk' && mode === 'unstage' ? 'unstageHunk' : op;
      void runHunkOp(effective, currentFile, hunk);
    },
    [
      current,
      currentFile,
      effectiveDiffs,
      conflictedSide,
      hunkOpsAvailable,
      runHunkOp,
      scope,
      ignoreWhitespace,
      stagedSide,
    ],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // A find field or a Monaco surface inside Review owns its own letters.
      if (isTypingEntry(e.target as Element)) return;
      const action = reviewActionFor(e);
      if (!action) return;
      // Enter belongs to whatever control has focus (see review-keymap.ts).
      if (!reviewActionAllowed(action, e.key, !!(e.target as Element)?.closest(INTERACTIVE_TARGET)))
        return;
      e.preventDefault();
      // Nothing outside Review may also act on a key Review just consumed: app shortcuts listen on
      // window and decide-shortcut.ts has no notion of this surface (spec 2026-07-03 §1).
      e.stopPropagation();
      switch (action) {
        case 'nextHunk':
          navigate(nextHunk);
          break;
        case 'prevHunk':
          navigate(prevHunk);
          break;
        case 'nextFile':
          navigate(nextFile);
          break;
        case 'prevFile':
          navigate(prevFile);
          break;
        case 'toggleReviewed':
          if (currentFile) onToggleReviewed(currentFile);
          break;
        case 'openHunk':
          jumpToCurrent();
          break;
        case 'addNote': {
          // The `+` on the current hunk’s first noteable row — the same path a mouse takes.
          if (!currentFile) break;
          const card = scrollerRef.current?.querySelector<HTMLElement>(cardSelector(currentFile));
          const scope =
            current && current.hunkIndex >= 0
              ? card
                  ?.querySelector<HTMLElement>(`.rhunk__jump[data-hunk="${current.hunkIndex}"]`)
                  ?.closest('.rhunk')
              : card;
          scope?.querySelector<HTMLElement>('.rline__note')?.click();
          break;
        }
        case 'stageHunk':
          // Upgraded to 'unstageHunk' inside runCurrentHunkOp when that is the action the
          // header is showing — the mode rule stays in exactly one place.
          runCurrentHunkOp('stageHunk');
          break;
        case 'discardHunk':
          runCurrentHunkOp('discardHunk');
          break;
        case 'expandAll':
          setAllCollapsed(false);
          break;
        case 'collapseAll':
          setAllCollapsed(true);
          break;
        case 'openSearch':
          openSearch();
          break;
        case 'toggleHelp':
          setHelpOpen((v) => !v);
          break;
      }
    },
    [
      current,
      currentFile,
      navigate,
      onToggleReviewed,
      jumpToCurrent,
      openSearch,
      runCurrentHunkOp,
      setAllCollapsed,
    ],
  );

  useEffect(() => {
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  const progress = computeReviewProgress(files, reviewed);

  // Nothing to accept or discard in a commit or a comparison — the action bar's overflow and
  // Stage all are hidden, not disabled (D10): a permanently greyed primary action reads as broken.
  const showActions = !preloaded && onGitAction !== undefined;
  // Reversible bulk ops fan out across repos; discard needs one repo (locked L11).
  const stageRoots = useMemo(() => {
    if (!grouped) return [];
    return groups
      .filter((g) =>
        (repoChanges?.find((r) => folderKey(r.root) === folderKey(g.root))?.changes ?? []).some(
          (c) => !c.staged,
        ),
      )
      .map((g) => g.root);
  }, [grouped, groups, repoChanges]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const onStageAll = useCallback(async () => {
    if (!onGitAction) return;
    setBulkBusy(true);
    try {
      if (grouped) {
        await onGitAction({ op: 'stageAll', repoRoots: stageRoots });
        setAnnounce(`Staged changes in ${plural(stageRoots.length, 'repo')}`);
      } else {
        await onGitAction({ op: 'stageAll', ...(requestRoot ? { repoRoot: requestRoot } : {}) });
      }
    } finally {
      setBulkBusy(false);
    }
  }, [onGitAction, grouped, stageRoots, requestRoot]);

  const pickFile = useCallback((f: ReviewFile) => scrollToFile(reviewFileKey(f)), [scrollToFile]);
  const navModel = useMemo<ReviewNavModel>(
    () => ({
      source,
      files,
      groups: grouped ? groups : null,
      repoRoot: resolved,
      repoCount: grouped ? groups.length : 1,
      totalCount: allFiles.length,
      activeKey,
      reviewed,
      canMark,
      filter: fileFilter,
      onPick: pickFile,
      onToggleReviewed,
      onFilter: setFileFilter,
    }),
    [
      source,
      files,
      grouped,
      groups,
      resolved,
      allFiles.length,
      activeKey,
      reviewed,
      canMark,
      fileFilter,
      pickFile,
      onToggleReviewed,
    ],
  );
  useEffect(() => {
    publishReviewNav(navModel);
  }, [navModel]);
  useEffect(() => () => publishReviewNav(null), []);

  const panelOn = !explorerCollapsed && paneTab === 'changes';
  const panelLabel = explorerCollapsed
    ? 'Show changes panel'
    : paneTab === 'files'
      ? 'Show changes'
      : 'Hide changes panel';
  const onPanelClick = useCallback(() => {
    if (explorerCollapsed) {
      onTogglePanel();
      onShowChanges();
    } else if (paneTab === 'files') onShowChanges();
    else onTogglePanel();
  }, [explorerCollapsed, paneTab, onShowChanges, onTogglePanel]);

  const headRef = useRef<HTMLDivElement | null>(null);
  // Below this the scope segment and stats have nowhere to go — the `…` menu carries scope
  // instead (spec 2026-09-07-overlay-layers §2.4, F1).
  const compact = useElementWidth(headRef) <= 480;

  // The chip only exists with a choice to make (spec §2.3); a single-repo session is today's header.
  const chipVisible = reviewRepos.length >= 2;
  const chipRows = useMemo(
    () => repoChipRows(reviewRepos, repoChanges, resolved, scope),
    [reviewRepos, repoChanges, resolved, scope],
  );
  const chipTitle =
    resolved === null
      ? `Reviewing all ${reviewRepos.length} repos`
      : repoDisplayPath(
          repoChanges?.find((r) => folderKey(r.root) === folderKey(resolved)) ?? { root: resolved },
        );
  const onPickRepo = useCallback(
    (root: string | null) => onSetSource(workingSource(scope, root ?? undefined)),
    [onSetSource, scope],
  );

  const [moreMenu, setMoreMenu] = useState<MenuState | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const moreWasOpenRef = useRef(false);
  const openMoreMenu = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (menuToggleIntent(moreWasOpenRef.current) === 'close') {
        setMoreMenu(null);
        return;
      }
      const anchor = anchorMenuToRect(e.currentTarget.getBoundingClientRect(), MENU_W);
      const scopeRows: MenuItem[] = compact
        ? REVIEW_SCOPES.map((s) => ({
            label: SCOPE_LABEL[s],
            checked: scopeOfSource(source) === s,
            // Same rule as the segment (review-source-control.tsx): undefined source means the
            // default working-tree review, which IS scopable — only a resolved commit/range isn't.
            disabled: source !== undefined && source.kind !== 'working',
            title:
              source !== undefined && source.kind !== 'working'
                ? 'A commit or comparison has no staged / unstaged split'
                : undefined,
            onClick: () =>
              onSetSource(
                workingSource(s, source?.kind === 'working' ? source.repoRoot : undefined),
              ),
          }))
        : [];
      const items: MenuItem[] = [
        ...scopeRows,
        {
          label: 'Collapse all',
          hint: 'Shift+E',
          separatorBefore: compact,
          onClick: () => setAllCollapsed(true),
        },
        { label: 'Expand all', hint: 'e', onClick: () => setAllCollapsed(false) },
        {
          label: 'Ignore whitespace',
          icon: ignoreWhitespace ? <IconCheck size={13} /> : undefined,
          checked: ignoreWhitespace,
          onClick: () => update({ reviewIgnoreWhitespace: !ignoreWhitespace }),
        },
        {
          label: 'Keyboard shortcuts',
          hint: '?',
          separatorBefore: true,
          onClick: () => setHelpOpen((v) => !v),
        },
      ];
      setMoreMenu({ x: anchor.x, y: anchor.y, items });
    },
    [compact, ignoreWhitespace, onSetSource, setAllCollapsed, source, update],
  );

  const [barMenu, setBarMenu] = useState<MenuState | null>(null);
  const barMoreRef = useRef<HTMLButtonElement | null>(null);
  const barWasOpenRef = useRef(false);
  const openBarMenu = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (menuToggleIntent(barWasOpenRef.current) === 'close') {
        setBarMenu(null);
        return;
      }
      const btnRect = e.currentTarget.getBoundingClientRect();
      const barRect = e.currentTarget.closest('.review__actionbar')?.getBoundingClientRect();
      // Above the whole bar, not just the button: the bar sits at the window's bottom edge, and
      // the button's own vertical centering inset (from align-items: center in the 44px-tall bar)
      // is bigger than the popover's gap, so anchoring to the button alone still dipped the menu
      // into the bar.
      const rect: Rect = barRect
        ? { left: btnRect.left, right: btnRect.right, top: barRect.top, bottom: btnRect.bottom }
        : btnRect;
      const anchor = anchorMenuToRect(rect, MENU_W);
      setBarMenu({
        ...anchor,
        anchor: rect,
        side: 'above',
        items: [
          grouped
            ? {
                label: 'Discard all changes…',
                danger: true,
                disabled: true,
                title: STR.discardPerRepo,
                onClick: () => {},
              }
            : {
                label: 'Discard all changes…',
                danger: true,
                onClick: () =>
                  void onGitAction?.({
                    op: 'discardAll',
                    ...(requestRoot ? { repoRoot: requestRoot } : {}),
                  }),
              },
        ],
      });
    },
    [onGitAction, grouped, requestRoot],
  );

  return (
    <div className="review docpage">
      <div className="review__head" ref={headRef}>
        <button
          type="button"
          className={`iconbtn review__panel${panelOn ? ' iconbtn--on' : ''}`}
          aria-pressed={panelOn ? true : undefined}
          aria-label={panelLabel}
          title={panelLabel}
          onClick={onPanelClick}
        >
          <IconPanelRight size={15} />
        </button>
        {chipVisible && (
          <ReviewRepoChip
            rows={chipRows}
            label={repoChipLabel(reviewRepos, resolved)}
            title={chipTitle}
            compact={compact}
            onPick={onPickRepo}
          />
        )}
        <ReviewSourceControl
          source={source}
          sessionId={sessionId}
          repoRoot={requestRoot}
          locked={grouped}
          onSetSource={onSetSource}
          onOpenCompare={onOpenCompare}
        />
        <div className="review__stats">
          <span className="review__sub">
            {files.length === 0 ? (
              'No changes'
            ) : (
              <>
                {plural(files.length, 'file')} ·{' '}
                <span className="diffstat--add">+{stat.insertions}</span>{' '}
                <span className="diffstat--del">−{stat.deletions}</span>
              </>
            )}
          </span>
          {files.length > 0 && (
            <>
              <span
                className="review__meter"
                role="progressbar"
                aria-label="Files reviewed"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.reviewed}
              >
                <span
                  className="review__meterfill"
                  style={{ width: `${progress.fraction * 100}%` }}
                />
              </span>
              <span className="review__count">
                {progress.reviewed} / {progress.total}
                <span className="review__countword"> reviewed</span>
              </span>
            </>
          )}
        </div>
        <div className="review__tools">
          <button
            type="button"
            className={`iconbtn review__find${searchOpen ? ' iconbtn--on' : ''}`}
            aria-pressed={searchOpen}
            aria-label="Search changed lines"
            title="Search changed lines (/)"
            onClick={toggleSearch}
          >
            <IconSearch size={15} />
          </button>
          <button
            ref={moreRef}
            type="button"
            className="iconbtn review__more"
            aria-haspopup="menu"
            aria-expanded={!!moreMenu}
            aria-label="More review actions"
            title="More"
            onMouseDown={() => {
              moreWasOpenRef.current = moreMenu !== null;
            }}
            onClick={openMoreMenu}
          >
            <IconMore size={15} />
          </button>
        </div>
      </div>
      {moreMenu && (
        <ContextMenu menu={moreMenu} onClose={() => setMoreMenu(null)} triggerRef={moreRef} />
      )}
      {truncated && (
        <div className="review__truncated">
          Showing {truncated.shown} of {truncated.total} files — the rest were omitted to stay
          responsive.
        </div>
      )}
      {searchOpen && (
        <ReviewFindBar
          query={query}
          caseSensitive={caseSensitive}
          ordinal={currentMatch + 1}
          count={results.matches.length}
          capped={results.capped}
          partial={preloaded ? null : partialLabel(results.loaded, results.total)}
          loading={searchAll}
          focusNonce={searchFocus}
          onQueryChange={setQuery}
          onToggleCase={() => setCaseSensitive((v) => !v)}
          onNext={() => stepSearch(1)}
          onPrev={() => stepSearch(-1)}
          onSearchAll={() => setSearchAll(true)}
          onClose={closeSearch}
        />
      )}

      <div
        ref={scrollerRef}
        className="review__scroll"
        // The keymap is scoped to focus inside this element, and opening Review from a tab click
        // leaves focus on the tab — so the scroller is focusable and claims it once (Lane B plan, assumption 11).
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onScroll={() => {
          const el = scrollerRef.current;
          if (!el) return;
          setScrollTop(el.scrollTop);
          lastAnchorRef.current = computeReviewAnchor(
            el.scrollTop,
            itemCount,
            heightOf,
            (i) => itemKeys[i],
          );
          scheduleAnchorCapture();
        }}
        onFocus={onFocusCapture}
        onBlur={onBlurCapture}
        aria-busy={anyInFlight}
      >
        {files.length === 0 ? (
          allFiles.length > 0 ? (
            <EmptyState
              variant="pane"
              icon={<IconReview size={28} />}
              title="No files match the filter"
              hint={`${allFiles.length} changed file${allFiles.length === 1 ? '' : 's'} are hidden — clear the filter to see them.`}
            />
          ) : preloadError ? (
            <EmptyState
              variant="pane"
              icon={<IconReview size={28} />}
              title={
                rangeError
                  ? `Couldn't compare: ${rangeError}`
                  : `Couldn't load this commit: ${preloadError}`
              }
              hint={
                rangeError
                  ? "One of the chosen refs couldn't be resolved."
                  : "The commit's changes couldn't be read from the repo."
              }
              action={
                sessionId ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() =>
                      rangeMode && source?.kind === 'range'
                        ? retryRangeDiff(sessionId, source.base, source.head, source.repoRoot)
                        : commitMode && source?.kind === 'commit'
                          ? retryCommitDiff(sessionId, source.sha, source.repoRoot)
                          : undefined
                    }
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
              hint={
                grouped
                  ? `All ${reviewRepos.length} repos are clean.`
                  : "The working tree is clean — make some changes and they'll show up here."
              }
            />
          )
        ) : (
          <>
            <div className="review__pad" style={{ height: view.padTop }} aria-hidden />
            {mounted.map((it) => {
              if (it.kind === 'group') {
                const g = groups[it.groupIndex];
                return <ReviewGroupHead key={`g:${folderKey(g.root)}`} group={g} />;
              }
              const c = files[it.fileIndex];
              const key = fileKeys[it.fileIndex];
              const diff = effectiveDiffs.get(key);
              return (
                <ReviewFileCard
                  // A card seeds its UI state from the cache ONCE, at mount. Keying by path alone
                  // would keep a file present in both changesets mounted across a source change,
                  // holding the previous diff's folds and writing them back over the cleared
                  // cache on its next edit. A different changeset is a different card.
                  key={`${viewKey}\u0000${key}`}
                  change={c}
                  abs={key}
                  diff={diff}
                  uiCache={uiCacheRef.current}
                  onUiChange={setCardUi}
                  onMeasure={onMeasure}
                  onRequestOnce={requestOnce}
                  onRetryDiff={retryDiff}
                  onJumpToHunk={onJumpToHunk}
                  mode={hunkButtonMode(
                    scope,
                    stagedSide.has(key),
                    conflictedSide.has(key) || diff?.unmerged === true,
                    ignoreWhitespace,
                  )}
                  hunkOpsAvailable={hunkOpsAvailable}
                  onHunkOp={runHunkOp}
                  onOpenDiff={onOpenDiff ? openDiffAtScope : undefined}
                  reviewed={reviewed.has(key)}
                  canMark={canMark(c)}
                  onToggleReviewed={onToggleReviewed}
                  revealNonce={reveal.path === key ? reveal.nonce : 0}
                  revealShowAll={reveal.showAll}
                  bulkCollapsed={bulk.collapsed}
                  bulkNonce={bulk.nonce}
                  ignoreWhitespace={ignoreWhitespace}
                  isCurrentFile={key === currentPath}
                  currentHunkIndex={key === currentPath ? (current?.hunkIndex ?? -1) : -1}
                  onSetCurrent={setCurrentFromCard}
                  onHunkCount={reportHunkCount}
                  notes={notesByKey.get(key) ?? EMPTY_NOTES}
                  notesReady={notesLoaded(notesSnapshot, normalizeRoot(c.repoRoot))}
                  composer={composer?.key === key ? composer : null}
                  refusedMessage={refusedFor(c.repoRoot)}
                  onAddNote={openComposer}
                  onSaveNote={saveNote}
                  onCancelNote={requestCloseComposer}
                  onEditNote={editNote}
                  onResolveNote={resolveNote}
                  onDeleteNote={deleteNote}
                  onComposerDirty={onComposerDirty}
                />
              );
            })}
            <div className="review__pad" style={{ height: view.padBottom }} aria-hidden />
          </>
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      </div>
      {files.length > 0 && (
        <div className="review__actionbar">
          <span className="review__notes">
            {repoNotes.length > 0
              ? `${plural(repoNotes.length, 'note')} · ${plural(pending.length, 'pending', 'pending')}`
              : ''}
          </span>
          <div className="review__actionbar-right">
            {showActions && (
              <button
                ref={barMoreRef}
                type="button"
                className="iconbtn review__barmore"
                aria-haspopup="menu"
                aria-expanded={!!barMenu}
                aria-label="More actions"
                title="More"
                onMouseDown={() => {
                  barWasOpenRef.current = barMenu !== null;
                }}
                onClick={openBarMenu}
              >
                <IconMore size={15} />
              </button>
            )}
            <button
              type="button"
              className="btn review__send"
              disabled={handoff.disabled || !notesReady}
              aria-disabled={handoff.disabled || !notesReady}
              aria-describedby={handoffHintId}
              title={handoff.title}
              onClick={onHandoff}
            >
              {/* The icon carries the button once the compact bar hides the label (§2.4). */}
              {handoffLive ? <IconSparkle size={14} /> : <IconCopy size={14} />}
              <span className="review__sendlabel">{handoff.label}</span>
            </button>
            <span id={handoffHintId} className="sr-only">
              {handoff.title}
            </span>
            {showActions && (
              <button
                type="button"
                className="btn btn--primary review__stageall"
                title={
                  grouped
                    ? `Stage every changed file in ${plural(stageRoots.length, 'repo')}`
                    : 'Stage every changed file'
                }
                disabled={bulkBusy}
                aria-busy={bulkBusy || undefined}
                onClick={() => void onStageAll()}
              >
                Stage all
              </button>
            )}
          </div>
          {barMenu && (
            <ContextMenu menu={barMenu} onClose={() => setBarMenu(null)} triggerRef={barMoreRef} />
          )}
        </div>
      )}
      {helpOpen && <ReviewKeyHelp onClose={() => setHelpOpen(false)} />}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** A repo's heading in All repos (spec 2026-09-23-mf-review §2.4). Not interactive; the
 *  navigator's group rows are the complete outline, since an off-window header unmounts. */
function ReviewGroupHead({ group }: { group: ReviewGroup }) {
  return (
    <div
      className="review__group"
      role="heading"
      aria-level={3}
      data-root={folderKey(group.root)}
      title={repoDisplayPath(group)}
    >
      <IconFolder size={13} />
      <span className="review__groupname">{group.name}</span>
      <RepoTagPill tag={group.tag} />
      <span className="review__groupmeta">
        {group.branch ? `${group.branch} · ` : ''}
        {plural(group.files.length, 'file')}
      </span>
      <span className="review__grouprule" aria-hidden />
    </div>
  );
}

/** The `?` panel. Its content is REVIEW_KEY_HELP so the printed table and the bound keys are one
 *  source (webview/review-keymap.ts) and can't drift apart. */
function ReviewKeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="review__help" role="dialog" aria-label="Review keyboard shortcuts">
      <div className="review__helphead">
        <span>Keyboard</span>
        <button type="button" className="review__helpclose" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="review__helplist">
        {REVIEW_KEY_HELP.map((row) => (
          <div key={row.keys} className="review__helprow">
            <dt>
              <kbd>{row.keys}</kbd>
            </dt>
            <dd>{row.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const emptyUi = (collapsed = false): CardUiState => ({
  folds: new Map(),
  showRemaining: false,
  collapsed,
});

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
  onRetryDiff,
  onJumpToHunk,
  mode,
  hunkOpsAvailable,
  onHunkOp,
  onOpenDiff,
  reviewed,
  canMark,
  onToggleReviewed,
  revealNonce,
  revealShowAll,
  bulkCollapsed,
  bulkNonce,
  ignoreWhitespace,
  isCurrentFile,
  currentHunkIndex,
  onSetCurrent,
  onHunkCount,
  notes,
  notesReady,
  composer,
  refusedMessage,
  onAddNote,
  onSaveNote,
  onCancelNote,
  onEditNote,
  onResolveNote,
  onDeleteNote,
  onComposerDirty,
}: {
  change: ReviewFile;
  /** The file's absolute path — also its key everywhere in Review (K1). */
  abs: string;
  diff: FileDiffDTO | undefined;
  uiCache: Map<string, CardUiState>;
  onUiChange: (key: string, next: CardUiState) => void;
  onMeasure: (key: string, cardHeight: number) => void;
  onRequestOnce: (absPath: string) => void;
  /** Re-read a diff whose read failed; the request-once guard would otherwise swallow it. */
  onRetryDiff: (absPath: string) => void;
  onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
  mode: HunkButtonMode;
  /** False for a commit or a comparison: there is nothing to stage. */
  hunkOpsAvailable: boolean;
  onHunkOp: (op: HunkOp, change: ReviewFile, hunk: ReviewHunk) => void;
  onOpenDiff: ((absPath: string, mode?: OpenMode) => void) | undefined;
  reviewed: boolean;
  canMark: boolean;
  onToggleReviewed: (file: ReviewFile) => void;
  /** Bumped by a navigator click targeting THIS card; a change (>0) expands it if collapsed. */
  revealNonce: number;
  /** Search reveals a match that may sit past the row cap, so the reveal lifts it too. */
  revealShowAll: boolean;
  bulkCollapsed: boolean;
  /** Bumped by Collapse all / Expand all; a change applies `bulkCollapsed` to this card. */
  bulkNonce: number;
  ignoreWhitespace: boolean;
  /** This card holds the keyboard cursor. */
  isCurrentFile: boolean;
  /** The cursor's hunk within THIS card, or -1 (not this card, or a card with no hunk). */
  currentHunkIndex: number;
  onSetCurrent: (key: string, hunkIndex: number) => void;
  onHunkCount: (key: string, count: number) => void;
  /** This file's notes, at whatever line they were last saved on. */
  notes: readonly ReviewNote[];
  /** False until the first `review:notes` push for this repo — the load gate (§4). */
  notesReady: boolean;
  /** The open composer, when it belongs to THIS file. */
  composer: ComposerTarget | null;
  /** Set when the repo is at its open-note cap; the composer refuses and says why. */
  refusedMessage: string | undefined;
  onAddNote: (
    key: string,
    side: NoteSide,
    line: number,
    snippet: string,
    anchor: string,
    origin?: HTMLElement,
  ) => void;
  onSaveNote: (body: string) => void;
  onCancelNote: (dirty: boolean) => void;
  onEditNote: (id: string, body: string) => void;
  onResolveNote: (id: string, resolved: boolean) => void;
  onDeleteNote: (note: ReviewNote) => void;
  onComposerDirty: (dirty: boolean) => void;
}) {
  const review: FileReview | null = useMemo(
    () => (diff ? reviewOfDiff(diff, ignoreWhitespace) : null),
    [diff, ignoreWhitespace],
  );

  // The two sides as whole files. The anchor a note is SAVED with and the one `reanchor` looks
  // for must come from the same text, or every note would detach on the next load.
  const noteLines = useMemo(
    () => ({
      new: diff && !diff.binary ? diff.work.split('\n') : [],
      old: diff && !diff.binary ? diff.head.split('\n') : [],
    }),
    [diff],
  );

  // Re-anchored on every diff refresh (§2 Lane F). A card whose diff has not landed shows no
  // notes at all rather than declaring them all detached.
  const anchored = useMemo<AnchoredNotes>(() => {
    if (!diff || diff.binary || notes.length === 0) return NO_NOTES;
    const byLine = new Map<string, ReviewNote[]>();
    const detached: AnchoredNote[] = [];
    for (const side of ['new', 'old'] as const) {
      const lines = side === 'new' ? noteLines.new : noteLines.old;
      for (const a of reanchor(
        notes.filter((n) => n.side === side),
        lines,
      )) {
        if (a.line === null) {
          detached.push(a);
          continue;
        }
        const key = `${side}:${a.line}`;
        const list = byLine.get(key);
        if (list) list.push(a.note);
        else byLine.set(key, [a.note]);
      }
    }
    return { byLine, detached };
  }, [diff, notes, noteLines]);

  const addNoteAt = useCallback(
    (side: NoteSide, line: number, origin: HTMLElement) => {
      const lines = side === 'new' ? noteLines.new : noteLines.old;
      const anchor = anchorAt(lines, line);
      if (anchor === null) return;
      onAddNote(abs, side, line, snippetOf(lines[line - 1] ?? ''), anchor, origin);
    },
    [abs, noteLines, onAddNote],
  );

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
    const report = () => onMeasure(abs, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [abs, onMeasure]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the computed review, not to the callback's identity.
  useEffect(() => {
    if (review) onHunkCount(abs, review.hunks.length);
  }, [abs, review]);

  // Local interaction state seeded from (and written back to) the per-path cache so the card
  // looks exactly as the user left it after scrolling out and back.
  const [ui, setUiState] = useState<CardUiState>(
    () => uiCache.get(abs) ?? emptyUi(bulkNonce > 0 && bulkCollapsed),
  );
  const setUi = useCallback(
    (updater: (prev: CardUiState) => CardUiState) =>
      setUiState((prev) => {
        const next = updater(prev);
        onUiChange(abs, next);
        return next;
      }),
    [abs, onUiChange],
  );

  // Navigator reveal: a click on this file's row bumps revealNonce; expand if collapsed. Works
  // whether the card was already mounted (this fires) or freshly mounted by the scroll (nonce is
  // already >0 on first render, so the effect still runs).
  // biome-ignore lint/correctness/useExhaustiveDependencies: expand is keyed to the nonce bump alone, not setUi re-identity.
  useEffect(() => {
    if (revealNonce === 0) return;
    setUi((prev) => {
      const showRemaining = prev.showRemaining || revealShowAll;
      if (!prev.collapsed && showRemaining === prev.showRemaining) return prev;
      return { ...prev, collapsed: false, showRemaining };
    });
  }, [revealNonce]);

  // Applied on a nonce CHANGE only, never on mount: a bulk toggle already wrote every path's
  // cache entry (which is what a fresh mount seeds from), so re-applying it here would undo a
  // reveal that mounted this card in the same commit — the case search hits every time it opens
  // a collapsed card the windower had not mounted.
  const bulkAppliedRef = useRef(bulkNonce);
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied on the nonce bump alone.
  useEffect(() => {
    if (bulkAppliedRef.current === bulkNonce) return;
    bulkAppliedRef.current = bulkNonce;
    setUi((prev) =>
      prev.collapsed === bulkCollapsed ? prev : { ...prev, collapsed: bulkCollapsed },
    );
  }, [bulkNonce]);

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
      className={`rcard${reviewed ? ' rcard--done' : ''}`}
      data-path={change.path}
      data-root={folderKey(change.repoRoot)}
      aria-label={`Changes in ${change.path}`}
    >
      <header className="rcard__head">
        <button
          type="button"
          className="rcard__toggle"
          aria-expanded={!collapsed}
          // A binary file (or one whose diff hasn't loaded) has no hunk header to ring, so the
          // card's own toggle carries the cursor instead.
          aria-current={isCurrentFile && currentHunkIndex < 0 ? 'true' : undefined}
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
          aria-label={`Open ${change.path} in the editor`}
          onClick={() => onJumpToHunk(abs, review?.hunks[0]?.startNewLine ?? 1)}
          {...middleClickProps(() =>
            onJumpToHunk(abs, review?.hunks[0]?.startNewLine ?? 1, 'background'),
          )}
        >
          <IconExternal size={13} />
        </button>
        {onOpenDiff && !diff?.binary && !diff?.image && (
          <button
            type="button"
            className="iconbtn iconbtn--sm rcard__sbs"
            aria-label="Open side-by-side diff"
            title="Open side-by-side diff"
            onClick={() => onOpenDiff(abs)}
            {...middleClickProps(() => onOpenDiff(abs, 'background'))}
          >
            <IconSplit size={13} />
          </button>
        )}
        <button
          type="button"
          className="rcard__reviewed"
          aria-pressed={reviewed}
          disabled={!canMark}
          title={
            canMark
              ? reviewed
                ? 'Clear the reviewed mark'
                : 'Mark this file reviewed (m)'
              : 'Loading diff…'
          }
          onClick={() => onToggleReviewed(change)}
        >
          {reviewed ? 'Reviewed' : 'Mark reviewed'}
        </button>
      </header>

      {!collapsed && (
        <div id={bodyId}>
          <DetachedNotes
            notes={anchored.detached}
            disabled={!notesReady}
            onResolve={onResolveNote}
            onDelete={onDeleteNote}
          />
          {diff?.error !== undefined ? (
            <div className="rcard__notice">
              {DIFF_READ_ERROR_NOTICE}{' '}
              <button
                type="button"
                className="viewer__notice-action"
                onClick={() => onRetryDiff(abs)}
              >
                Retry
              </button>
            </div>
          ) : diff?.unmerged ? (
            <div className="rcard__notice">
              Conflicted file — review it under All scope. A conflict has no staged version to
              compare against.
            </div>
          ) : diff?.image ? (
            <ImageDiff doc={diff} />
          ) : diff?.oversize ? (
            <div className="rcard__notice rcard__notice--oversize">
              This file is too large to diff ({(diff.oversize.bytes / (1024 * 1024)).toFixed(1)}{' '}
              MB). Use “Open file” above to view it.
            </div>
          ) : diff?.binary ? (
            <div className="rcard__notice">Binary file — no diff preview.</div>
          ) : !review ? (
            <div className="rcard__notice rcard__notice--loading">Loading diff…</div>
          ) : review.hunks.length === 0 ? (
            <div className="rcard__notice">No textual changes.</div>
          ) : (
            <>
              {review.approx && (
                <div className="rcard__notice rcard__notice--oversize">
                  This file changed too much to line-match — showing it as a whole-file replacement.
                </div>
              )}
              <HunkList
                review={review}
                abs={abs}
                change={change}
                mode={mode}
                hunkOpsAvailable={hunkOpsAvailable}
                onHunkOp={onHunkOp}
                ui={ui}
                setUi={setUi}
                onJumpToHunk={onJumpToHunk}
                hljsLang={hljsLang}
                currentHunkIndex={currentHunkIndex}
                onSetCurrent={(hunkIndex) => onSetCurrent(abs, hunkIndex)}
                notesByLine={anchored.byLine}
                notesReady={notesReady}
                composer={composer}
                refusedMessage={refusedMessage}
                onAddNoteAt={addNoteAt}
                onSaveNote={onSaveNote}
                onCancelNote={onCancelNote}
                onEditNote={onEditNote}
                onResolveNote={onResolveNote}
                onDeleteNote={onDeleteNote}
                onComposerDirty={onComposerDirty}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
});

function HunkList({
  review,
  abs,
  change,
  mode,
  hunkOpsAvailable,
  onHunkOp,
  ui,
  setUi,
  onJumpToHunk,
  hljsLang,
  currentHunkIndex,
  onSetCurrent,
  notesByLine,
  notesReady,
  composer,
  refusedMessage,
  onAddNoteAt,
  onSaveNote,
  onCancelNote,
  onEditNote,
  onResolveNote,
  onDeleteNote,
  onComposerDirty,
}: {
  review: FileReview;
  abs: string;
  change: ReviewFile;
  mode: HunkButtonMode;
  hunkOpsAvailable: boolean;
  onHunkOp: (op: HunkOp, change: ReviewFile, hunk: ReviewHunk) => void;
  ui: CardUiState;
  setUi: (updater: (prev: CardUiState) => CardUiState) => void;
  onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
  hljsLang: string | null;
  currentHunkIndex: number;
  onSetCurrent: (hunkIndex: number) => void;
  notesByLine: ReadonlyMap<string, ReviewNote[]>;
  notesReady: boolean;
  composer: ComposerTarget | null;
  refusedMessage: string | undefined;
  onAddNoteAt: (side: NoteSide, line: number, origin: HTMLElement) => void;
  onSaveNote: (body: string) => void;
  onCancelNote: (dirty: boolean) => void;
  onEditNote: (id: string, body: string) => void;
  onResolveNote: (id: string, resolved: boolean) => void;
  onDeleteNote: (note: ReviewNote) => void;
  onComposerDirty: (dirty: boolean) => void;
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

  const rows: ReactJSX.Element[] = [];
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
          index={i}
          current={i === currentHunkIndex}
          maxLines={shown[i]}
          abs={abs}
          onJumpToHunk={onJumpToHunk}
          onSetCurrent={onSetCurrent}
          hljsLang={hljsLang}
          mode={mode}
          untracked={change.kind === 'U'}
          hunkOpsAvailable={hunkOpsAvailable}
          onHunkOp={(op) => onHunkOp(op, change, hunk)}
          notesByLine={notesByLine}
          notesReady={notesReady}
          composer={composer}
          refusedMessage={refusedMessage}
          onSaveNote={onSaveNote}
          onCancelNote={onCancelNote}
          onEditNote={onEditNote}
          onResolveNote={onResolveNote}
          onDeleteNote={onDeleteNote}
          onComposerDirty={onComposerDirty}
        />,
      );
    }
  }
  return (
    <>
      {/* inkbox: the diff body is a code surface, so under Aero it stays on the ink tiers even
          though the document around it went back to the light page (blockers.md Q2). */}
      {/* The `+` reaches its handler by DELEGATION: Line is memoised on primitives for a perf
          reason, and a callback prop would re-tokenise every row of the card on any parent
          re-render (Lane F plan, assumption 13). */}
      <div
        className="rhunks inkbox"
        onClick={(e) => {
          const btn = (e.target as HTMLElement).closest<HTMLElement>('.rline__note');
          if (!btn) return;
          const side = btn.dataset.noteSide as NoteSide | undefined;
          const line = Number(btn.dataset.noteLine);
          if (!side || !Number.isFinite(line)) return;
          onAddNoteAt(side, line, btn);
        }}
      >
        {rows}
      </div>
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

/** Discard reverts the WORKTREE to the index, so it is only meaningful where the hunks on
 *  screen describe that diff: not under the Staged scope, and never for an untracked file
 *  (there is no index entry to revert to). */
/** Why a non-actionable mode is not actionable. Shared by the buttons and the key handler so
 *  the spoken reason and the tooltip cannot drift. */
function blockedReason(mode: HunkButtonMode): string {
  if (mode === 'unmerged') return UNMERGED_TOOLTIP;
  if (mode === 'whitespace') return WHITESPACE_TOOLTIP;
  return BLOCKED_TOOLTIP;
}

function discardTitle(mode: HunkButtonMode, untracked: boolean): string {
  if (mode === 'unmerged') return UNMERGED_TOOLTIP;
  if (mode === 'whitespace') return WHITESPACE_TOOLTIP;
  if (untracked) return UNTRACKED_DISCARD_TOOLTIP;
  if (mode === 'unstage') return STAGED_DISCARD_TOOLTIP;
  if (mode === 'blocked') return BLOCKED_TOOLTIP;
  return 'Discard this hunk (d)';
}

function Hunk({
  hunk,
  index,
  current,
  maxLines,
  abs,
  onJumpToHunk,
  onSetCurrent,
  hljsLang,
  mode,
  untracked,
  hunkOpsAvailable,
  onHunkOp,
  notesByLine,
  notesReady,
  composer,
  refusedMessage,
  onSaveNote,
  onCancelNote,
  onEditNote,
  onResolveNote,
  onDeleteNote,
  onComposerDirty,
}: {
  hunk: ReviewHunk;
  index: number;
  current: boolean;
  maxLines: number;
  abs: string;
  onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
  onSetCurrent: (hunkIndex: number) => void;
  hljsLang: string | null;
  mode: HunkButtonMode;
  untracked: boolean;
  hunkOpsAvailable: boolean;
  onHunkOp: (op: HunkOp) => void;
  notesByLine: ReadonlyMap<string, ReviewNote[]>;
  notesReady: boolean;
  composer: ComposerTarget | null;
  refusedMessage: string | undefined;
  onSaveNote: (body: string) => void;
  onCancelNote: (dirty: boolean) => void;
  onEditNote: (id: string, body: string) => void;
  onResolveNote: (id: string, resolved: boolean) => void;
  onDeleteNote: (note: ReviewNote) => void;
  onComposerDirty: (dirty: boolean) => void;
}) {
  const lines = maxLines < hunk.lines.length ? hunk.lines.slice(0, maxLines) : hunk.lines;
  // Word-level emphasis for adjacent del→add replacement pairs (spec 2026-07-01-review-word-diff).
  // Computed over the FULL hunk (pairing is a hunk property, independent of the row cap) so each
  // emphasized line's span array keeps a stable identity across cap toggles — Line's memo relies
  // on it. Only mounted (windowed) cards run this, so it's off the scroll hot path.
  const emphBySeq = useMemo(() => computeReplacementEmphasis(hunk.lines), [hunk.lines]);
  return (
    <div className="rhunk">
      <div className="rhunk__head">
        <button
          type="button"
          className={`rhunk__jump${current ? ' rhunk__jump--current' : ''}`}
          data-hunk={index}
          aria-current={current ? 'true' : undefined}
          title="Open this hunk in the editor (o)"
          onClick={() => {
            onSetCurrent(index);
            onJumpToHunk(abs, hunk.startNewLine);
          }}
          // Queues the hunk without moving the Review's own current hunk.
          {...middleClickProps(() => onJumpToHunk(abs, hunk.startNewLine, 'background'))}
        >
          {formatHunkHeader(hunk)}
        </button>
        {hunkOpsAvailable && (
          <div className="rhunk__acts">
            {mode === 'unstage' ? (
              <button
                type="button"
                className="rhunk__act"
                title="Unstage this hunk (s)"
                onClick={() => onHunkOp('unstageHunk')}
              >
                Unstage
              </button>
            ) : (
              <button
                type="button"
                className="rhunk__act"
                disabled={mode !== 'stage'}
                title={mode === 'stage' ? 'Stage this hunk (s)' : blockedReason(mode)}
                onClick={() => onHunkOp('stageHunk')}
              >
                Stage
              </button>
            )}
            <button
              type="button"
              className="rhunk__act rhunk__act--danger"
              disabled={mode !== 'stage' || untracked}
              title={discardTitle(mode, untracked)}
              onClick={() => onHunkOp('discardHunk')}
            >
              Discard
            </button>
          </div>
        )}
      </div>
      <div className="rhunk__lines">
        {lines.map((l) => {
          // A row is noteable on the side it exists on; a context row is pinned to `new`.
          const side: NoteSide = l.newLine !== null ? 'new' : 'old';
          const anchorLine = l.newLine ?? l.oldLine;
          const rowNotes =
            (anchorLine === null ? undefined : notesByLine.get(`${side}:${anchorLine}`)) ??
            EMPTY_NOTES;
          const composing =
            composer !== null && composer.side === side && composer.line === anchorLine;
          return (
            <Fragment key={l.seq}>
              <Line
                line={l}
                hljsLang={hljsLang}
                emph={emphBySeq.get(l.seq)}
                noteSide={anchorLine === null ? null : side}
                noteAnchorLine={anchorLine}
                noteCount={rowNotes.length}
                notesReady={notesReady}
              />
              {rowNotes.map((n) => (
                <NoteThread
                  key={n.id}
                  note={n}
                  disabled={!notesReady}
                  onEdit={onEditNote}
                  onResolve={onResolveNote}
                  onDelete={onDeleteNote}
                />
              ))}
              {composing && (
                <NoteComposer
                  label={`Note on line ${anchorLine}`}
                  refused={refusedMessage}
                  onSave={onSaveNote}
                  onCancel={onCancelNote}
                  onDirtyChange={onComposerDirty}
                />
              )}
            </Fragment>
          );
        })}
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
  noteSide = null,
  noteAnchorLine = null,
  noteCount = 0,
  notesReady = false,
}: {
  line: ReviewLine;
  hljsLang: string | null;
  /** Char spans that changed vs. this line's replacement counterpart; wrapped in `.rline__word`. */
  emph?: WordSpan[];
  /** Which side a note on this row anchors to; null ⇒ no `+` (a fold row).
   *  ONLY primitives reach this memoised component — see the Lane F plan, assumption 13. */
  noteSide?: NoteSide | null;
  noteAnchorLine?: number | null;
  noteCount?: number;
  notesReady?: boolean;
}) {
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
    // `data-seq` addresses the row for search reveal and highlight painting, and for Lane F's
    // note rows — an index-based lookup breaks as soon as non-diff rows interleave.
    <pre className={`rline rline--${line.kind}${plain ? '' : ' rline--hl'}`} data-seq={line.seq}>
      {/* Dual gutters (design 5b/5e): the old and the new line number side by side. A blank
          cell IS the signal that the line only exists on one side — the same information a
          split view carries, in one column. */}
      <span className="rline__gutter">{line.oldLine ?? ''}</span>
      <span className="rline__gutter">{line.newLine ?? ''}</span>
      <span className="rline__sign">{SIGN[line.kind]}</span>
      {noteSide !== null && noteAnchorLine !== null && (
        <button
          type="button"
          className="rline__note"
          disabled={!notesReady}
          data-note-side={noteSide}
          data-note-line={noteAnchorLine}
          aria-label={`Add note on line ${noteAnchorLine}`}
          title="Add a note (c)"
        >
          +
        </button>
      )}
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
      {noteCount > 0 && (
        <span
          className="rline__notecount"
          aria-label={`${noteCount} note${noteCount === 1 ? '' : 's'}`}
        >
          {noteCount}
        </span>
      )}
    </pre>
  );
});

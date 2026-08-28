import type { JSX as ReactJSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import type { HunkOp } from '../../src/git-actions';
import { endpointLabel, rangeKey } from '../../src/git-range';
import { hunkRange } from '../../src/hunk-patch';
import { langFromPath } from '../../src/lang';
import type { ChangeDTO, FileDiffDTO, ReviewMark, ReviewNote } from '../../src/protocol';
import { buildHandoffMarkdown, handoffLabel } from '../../src/review-handoff';
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
import { gitAction } from '../bridge';
import type { ReviewSource } from '../docs';
import { joinPath } from '../file-tree';
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
import { IconChevron, IconExternal, IconReview, IconSidebar } from '../icons';
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
import { getNoteTarget, subscribeNoteTarget } from '../review-note-target';
import {
  getNotesSnapshot,
  loadNotesFor,
  notesFor,
  notesLoaded,
  patchNotes,
  subscribeNotes,
} from '../review-notes-store';
import { diffsForScope, type ReviewScope, SCOPE_LABEL, scopeOfSource } from '../review-scope';
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
  planRowCap,
  resolveReviewAnchor,
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
import { useEscapeKey } from '../use-escape-key';
import { retryRangeDiff, useRangeFiles } from '../use-range-files';
import {
  deleteViewState,
  getViewState,
  mergeReviewViewState,
  VIEW_STATE_DEBOUNCE_MS,
} from '../view-state-store';
import { ConfirmDialog, type ConfirmState } from './confirm-dialog';
import { EmptyState } from './empty-state';
import { ImageDiff } from './image-diff';
import { DetachedNotes, NoteComposer, NoteThread } from './note-thread';
import { ReviewFindBar } from './review-find-bar';
import type { GitActionIntent } from './right-pane';
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
/** Seed height for a file-list row before the first one is measured. Every row is identical,
 *  so one measurement corrects the whole column at any density or font scale. */
const NAV_ROW_H = 44;
const NO_MEASURED = new Map<number, number>();
/** Stable empty list so the preloaded-files memo doesn't re-run for working/streaming sources. */
const EMPTY_FILES: FileDiffDTO[] = [];
/** Stable empty list so a repo with no marks doesn't re-identify the memo on every render. */
const EMPTY_MARKS: ReviewMark[] = [];
/** Stable identity, same reason as EMPTY_MARKS: an unnoted card must not re-run its memo. */
const EMPTY_NOTES: readonly ReviewNote[] = [];

/** Where an open note composer sits. One at a time, owned by ReviewView (plan assumption 12). */
interface ComposerTarget {
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
  onOpenDiff,
  onGitAction,
  onClose,
  source,
  sessionId,
  sessionLabel,
  viewStateId,
}: {
  /** The active repo root — change paths are relative to it (multi-repo workspaces). */
  changesRoot: string | undefined;
  /** Working-tree changes (the Changes panel's list). One review card per file. */
  changes: ChangeDTO[];
  /** Diff content keyed by ABSOLUTE path (head/work), filled in as the host replies. */
  diffs: Map<string, FileDiffDTO>;
  /** Ask the host for a file's diff (absolute path) at the current scope. Once per changed file. */
  onRequestDiff: (absPath: string, scope: ReviewScope) => void;
  /** Open the file in the editor revealed at a hunk's WORK line. */
  onJumpToHunk: (absPath: string, line: number) => void;
  /** Card header "Split": open this file's real side-by-side diff (the dual gutters are the
   *  inline answer; Split is the escape hatch the design keeps for when they aren't enough). */
  onOpenDiff?: (absPath: string) => void;
  /** Footer actions. Routed through the app's existing intent handler so Discard gets the same
   *  confirm dialog the Changes panel uses (D10) — no second destructive path. */
  onGitAction?: (intent: GitActionIntent) => void;
  onClose: () => void;
  /** What this Review tab is scoped to (working tree vs. a commit). Absent ⇒ working. */
  source?: ReviewSource;
  /** Owning session — scopes the commit-files loader to its repo. */
  sessionId?: string;
  /** The Review doc's session, named for the handoff toast — a Review only shows while its
   *  owning session is active. */
  sessionLabel?: string;
  /** The owning doc id — keys this list's scroll-anchor memory (spec 2026-06-30). */
  viewStateId?: string;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchAll, setSearchAll] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [fileFilter, setFileFilter] = useState('');

  const scrollerRef = useRef<HTMLDivElement>(null);

  // Note composer state lives HERE, not in the card: Esc must unwind composer → search → help
  // → Review in that order and `useEscapeKey` listens on window, so the state has to be visible
  // where the unwind is decided (Lane F plan, assumption 12).
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const composerRef = useRef<ComposerTarget | null>(null);
  composerRef.current = composer;
  const composerDirtyRef = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const confirmRef = useRef<ConfirmState | null>(null);
  confirmRef.current = confirm;
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
      if (confirmRef.current) return; // ConfirmDialog owns its own Escape
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
    if (!preloaded) return diffsForScope(diffs, scope);
    const m = new Map<string, FileDiffDTO>();
    for (const f of preloadedFiles) m.set(absOf(f.path), f);
    return m;
  }, [preloaded, preloadedFiles, diffs, absOf, scope]);
  const effectiveChanges = useMemo(
    () => (preloaded ? commitChangesFromFiles(preloadedFiles) : changes),
    [preloaded, preloadedFiles, changes],
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

  // A change can appear twice (staged + unstaged side); review each PATH once. Under a
  // narrowed scope only that side's entries qualify, so a path changed on both sides appears
  // in all three scopes — with only that side's hunks (§2 Lane D).
  const allFiles = useMemo(() => {
    const seen = new Set<string>();
    const out: ChangeDTO[] = [];
    for (const c of effectiveChanges) {
      if (scope === 'staged' && !c.staged) continue;
      if (scope === 'unstaged' && c.staged) continue;
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push(c);
    }
    return out;
  }, [effectiveChanges, scope]);

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

  const pathIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < files.length; i++) m.set(files[i].path, i);
    return m;
  }, [files]);

  // path → real hunk count, reported by the card that computed it. A file the window hasn't
  // mounted has no entry: its change's own +/- counts stand in (Lane B plan, assumption 10). Re-running
  // computeFileReview here for every file would undo the virtualization this list exists for.
  const hunkCountsRef = useRef<Map<string, number>>(new Map());
  const [, setHunkTick] = useState(0);
  const reportHunkCount = useCallback((path: string, count: number) => {
    if (hunkCountsRef.current.get(path) === count) return;
    hunkCountsRef.current.set(path, count);
    setHunkTick((t) => t + 1);
  }, []);

  // Computed inline so it reads the fresh ref on every render, exactly like `win`.
  const fileHunks: ReviewFileHunks[] = files.map((c) => ({
    path: c.path,
    hunkCount: hunkCountsRef.current.get(c.path) ?? (c.added + c.removed > 0 ? 1 : 0),
  }));
  const fileHunksRef = useRef(fileHunks);
  fileHunksRef.current = fileHunks;

  // Diffstat header — a pure fold over the deduped file list the cards read (spec §Data). Exact
  // for all three sources; binary files count in `files` with 0 lines.
  const stat = useMemo(() => computeDiffstat(files), [files]);

  // path → measured SLOT height (card border-box + GAP); keyed by path so it survives
  // re-scan/reorder of `changes` (index is not stable, path is).
  const measuredRef = useRef<Map<string, number>>(new Map());
  // Absolute paths already requested — dedupes a card scrolled out and back (Decision D1).
  const requestedRef = useRef<Set<string>>(new Set());
  // Per-path UI state cache (fold reveals + "Show remaining"); see CardUiState.
  const uiCacheRef = useRef<Map<string, CardUiState>>(new Map());
  // Collapsing every card at once invalidates the scroll offset outright. Re-anchor to the file
  // the user was on after each measurement until the offset stops moving — the ResizeObserver
  // reports the new heights over the next frame or two (Lane B plan, assumption 14).
  const keepInViewRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);
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
  const [measureTick, setMeasureTick] = useState(0);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  // Lane D's contract: a path modified in BOTH the index and the worktree produces two
  // ChangeDTOs, and `files` dedupes them for rendering — so the staged side is read off the
  // undeduped list.
  const stagedSide = useMemo(
    () => new Set(effectiveChanges.filter((c) => c.staged).map((c) => c.path)),
    [effectiveChanges],
  );
  // A conflicted path has no stage-0 index blob to apply against. Under a narrowed scope the
  // card is a notice with no hunks at all; under All it renders normally, so the buttons are
  // what has to say no.
  const conflictedSide = useMemo(
    () => new Set(effectiveChanges.filter((c) => c.conflicted).map((c) => c.path)),
    [effectiveChanges],
  );
  // Hunk ops exist for the working source only — a commit or a comparison has nothing to stage.
  const hunkOpsAvailable = !preloaded;

  const hunkHost = useSyncExternalStore(
    subscribeHunkActionHost,
    getHunkActionHost,
    getHunkActionHost,
  );

  const runHunkOp = useCallback(
    async (op: HunkOp, change: ChangeDTO, hunk: ReviewHunk) => {
      const abs = absOf(change.path);
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
    [absOf, effectiveDiffs, hunkHost],
  );

  const { settings, update } = useSettings();
  const ignoreWhitespace = settings.reviewIgnoreWhitespace;
  const navOpen = settings.reviewFileListOpen;
  // A navigator click sets this to (target path, bumped nonce); the target card's reveal effect
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
    ref: null,
    reveal: 0,
  });
  const current = cursor.ref;

  const navigate = useCallback(
    (step: (list: ReviewFileHunks[], c: HunkRef | null) => HunkRef | null) => {
      setCursor((cur) => ({ ref: step(fileHunksRef.current, cur.ref), reveal: cur.reveal + 1 }));
    },
    [],
  );

  // Also the reviewed-mark `source` key, so All keeps the bare 'working' every existing mark
  // was written under. A narrowed scope is a DIFFERENT changeset with different content
  // hashes; sharing one key would make each scope retire the other's marks as stale.
  const sourceKey =
    source?.kind === 'commit'
      ? `commit:${source.sha}`
      : source?.kind === 'range'
        ? `range:${rangeKey(source.base, source.head)}`
        : scope === 'all'
          ? 'working'
          : `working:${scope}`;

  // Drop the per-path caches DURING RENDER rather than in the [sourceKey] effect below:
  // effects run child-first, so a card would re-run its request-once effect against the
  // previous scope's dedupe set and never re-fetch.
  const prevSourceKeyRef = useRef(sourceKey);
  if (prevSourceKeyRef.current !== sourceKey) {
    prevSourceKeyRef.current = sourceKey;
    requestedRef.current.clear();
    hunkCountsRef.current.clear();
    measuredRef.current.clear();
  }

  // Per-file reviewed marks. Durable, host-owned and shared across windows (spec
  // 2026-08-27-review-supercharge §2 Lane B) — this view only reads them and toggles one.
  const marks = useSyncExternalStore(subscribeMarks, getMarksSnapshot, getMarksSnapshot);
  // One key for BOTH per-repo stores: reviewed marks (Lane B) and review notes (Lane F).
  const repoKey = effectiveRoot ? normalizeRoot(effectiveRoot) : '';
  const rootMarks = marks.byRoot.get(repoKey) ?? EMPTY_MARKS;

  // The receipt a mark is checked against: the new-side text of every file whose diff HAS loaded.
  // A file that isn't loaded has no entry, and is therefore neither reviewed nor stale.
  const hashes = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) {
      const d = effectiveDiffs.get(absOf(f.path));
      if (d) m.set(f.path, hashOfDiff(d));
    }
    return m;
  }, [files, effectiveDiffs, absOf]);

  const reviewed = useMemo(
    () => reviewedPaths(rootMarks, sourceKey, hashes),
    [rootMarks, sourceKey, hashes],
  );

  /** A mark can only be made once we can hash what is being marked (Lane B plan, assumption 8). */
  const canMark = useCallback(
    (path: string) => marks.loaded && repoKey !== '' && hashes.has(path),
    [marks.loaded, repoKey, hashes],
  );

  const onToggleReviewed = useCallback(
    (path: string) => {
      const hash = hashes.get(path);
      if (!canMark(path) || hash === undefined) {
        // The control is disabled, but `m` reaches this path from the keyboard too.
        if (marks.loaded && repoKey !== '') setAnnounce(`Still loading the diff for ${path}`);
        return;
      }
      const on = !reviewed.has(path);
      setReviewMark(
        repoKey,
        { source: sourceKey, path, contentHash: hash, at: new Date().toISOString() },
        on,
      );
      setAnnounce(on ? `Marked ${path} reviewed` : `Unmarked ${path}`);
    },
    [hashes, canMark, reviewed, repoKey, sourceKey, marks.loaded],
  );

  // A mark whose file has changed since is RETIRED, not merely hidden (§2 Lane B). The host has
  // no file text, so the side that can tell is the one that does it.
  useEffect(() => {
    if (!marks.loaded || repoKey === '') return;
    for (const m of staleMarks(rootMarks, sourceKey, hashes)) setReviewMark(repoKey, m, false);
  }, [marks.loaded, repoKey, rootMarks, sourceKey, hashes]);

  // Per-repo review notes. Durable, host-owned, shared across windows and readable by the
  // agent (spec §2 Lane F); this view reads them and sends one patch at a time.
  const notesSnapshot = useSyncExternalStore(subscribeNotes, getNotesSnapshot, getNotesSnapshot);
  const repoNotes = notesFor(notesSnapshot, repoKey);
  const notesReady = notesLoaded(notesSnapshot, repoKey);

  useEffect(() => {
    if (repoKey) loadNotesFor(repoKey);
  }, [repoKey]);

  const notesByPath = useMemo(() => {
    const m = new Map<string, ReviewNote[]>();
    for (const n of repoNotes) {
      const list = m.get(n.path);
      if (list) list.push(n);
      else m.set(n.path, [n]);
    }
    return m;
  }, [repoNotes]);

  const refusedMessage = canAddNote(repoNotes)
    ? undefined
    : 'Resolve or delete some notes first — this repository is at 500 open notes.';

  const openComposer = useCallback(
    (
      path: string,
      side: NoteSide,
      line: number,
      snippet: string,
      anchor: string,
      origin?: HTMLElement,
    ) => {
      if (!notesReady || !repoKey) {
        setAnnounce('Still loading notes for this repository');
        return;
      }
      composerOriginRef.current = origin ?? null;
      composerDirtyRef.current = false;
      setComposer({ path, side, line, snippet, anchor });
    },
    [notesReady, repoKey],
  );

  const saveNote = useCallback(
    (body: string) => {
      const target = composerRef.current;
      if (!target || !repoKey) return;
      patchNotes(repoKey, {
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
    [repoKey, closeComposer],
  );

  const editNote = useCallback(
    (id: string, body: string) => {
      if (repoKey) patchNotes(repoKey, { op: 'edit', id, body });
    },
    [repoKey],
  );

  const resolveNote = useCallback(
    (id: string, resolved: boolean) => {
      if (!repoKey) return;
      patchNotes(repoKey, { op: 'resolve', id, resolved, at: new Date().toISOString() });
      setAnnounce(resolved ? 'Note resolved' : 'Note reopened');
    },
    [repoKey],
  );

  // Destructive, so it confirms — the same dialog the Changes panel uses (D10).
  const deleteNote = useCallback(
    (note: ReviewNote) => {
      if (!repoKey) return;
      setConfirm({
        title: 'Delete this note?',
        message: `The note on line ${note.line} of ${note.path} will be removed. This can\u2019t be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        focusCancel: true,
        onConfirm: () => {
          patchNotes(repoKey, { op: 'delete', id: note.id });
          setAnnounce('Note deleted');
        },
      });
    },
    [repoKey],
  );

  const onComposerDirty = useCallback((dirty: boolean) => {
    composerDirtyRef.current = dirty;
  }, []);

  const pending = useMemo(() => pendingNotes(repoNotes), [repoNotes]);
  // A terminal can register or go away between renders and neither is a state update here, so
  // the bus's version counter is what re-renders this control (terminal-bus.ts).
  useSyncExternalStore(subscribeTerminalBus, getTerminalBusVersion, getTerminalBusVersion);
  const handoff = handoffLabel(pending.length, sessionId ? hasLiveTerminal(sessionId) : false);
  const handoffHintId = useId();

  const sourceLabel =
    source?.kind === 'commit'
      ? `commit ${source.sha.slice(0, 7)}`
      : source?.kind === 'range'
        ? `${endpointLabel(source.base)}…${endpointLabel(source.head)}`
        : scope === 'all'
          ? 'working tree'
          : `${SCOPE_LABEL[scope].toLowerCase()} changes`;

  const onHandoff = useCallback(() => {
    if (pending.length === 0 || !repoKey) return;
    const md = buildHandoffMarkdown(
      pending,
      files.map((f) => f.path),
      sourceLabel,
    );
    const plural = pending.length === 1 ? '' : 's';
    const stamp = () => {
      patchNotes(repoKey, {
        op: 'sent',
        ids: pending.map((n) => n.id),
        at: new Date().toISOString(),
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
  }, [pending, repoKey, files, sourceLabel, sessionId, sessionLabel]);

  // Reset scroll + focus when the SOURCE changes so a stale offset can't strand the user
  // mid-list, and announce the new source to SR users (spec §4 + §10). The per-path caches
  // are keyed by path and harmlessly carry across (different files).
  // biome-ignore lint/correctness/useExhaustiveDependencies: must fire only on a source CHANGE (sourceKey), not when the referenced setters/source re-identify; see spec §4.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
    setFocusedPath(null);
    const label = reviewSourceLabel(source).replace(/^Reviewing /, 'reviewing ');
    setAnnounce(`Now ${label}${scope === 'all' ? '' : ` — ${SCOPE_LABEL[scope]} only`}`);
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

  // Narrowing the file filter shortens the list under the scroller; a kept offset would strand
  // the user below the new content. Same reset the source change does, for the same reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is the trigger.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [fileFilter]);

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
    if (id && lastAnchorRef.current) mergeReviewViewState(id, { anchor: lastAnchorRef.current });
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
    (path: string, showAll = false) => {
      const el = scrollerRef.current;
      if (!el || pathIndex.get(path) === undefined) return;
      const top = resolveReviewAnchor({ topPath: path, offset: 0 }, files.length, heightOf, (p) =>
        pathIndex.get(p),
      );
      // An explicit jump supersedes a pending "keep this file in view" anchor from a bulk
      // collapse: otherwise the next measurement drags the scroller straight back (onMeasure).
      keepInViewRef.current = null;
      el.scrollTop = top;
      setScrollTop(top);
      setReveal((r) => ({ path, nonce: r.nonce + 1, showAll }));
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

      const keep = keepInViewRef.current;
      if (keep !== null && el) {
        const want = resolveReviewAnchor(
          { topPath: keep, offset: 0 },
          files.length,
          heightOf,
          (p) => pathIndex.get(p),
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
    [files, pathIndex, estimateSlot, heightOf],
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

  const setCardUi = useCallback((path: string, next: CardUiState) => {
    uiCacheRef.current.set(path, next);
  }, []);

  // A bulk toggle has to reach cards the window hasn't mounted, so it writes the per-path cache
  // (which a fresh mount seeds from) AND bumps a nonce the mounted cards react to.
  const [bulk, setBulk] = useState<{ collapsed: boolean; nonce: number }>({
    collapsed: false,
    nonce: 0,
  });

  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      for (const f of files) {
        const prev = uiCacheRef.current.get(f.path) ?? emptyUi(collapsed);
        uiCacheRef.current.set(f.path, { ...prev, collapsed });
      }
      keepInViewRef.current = activePathRef.current;
      setBulk((b) => ({ collapsed, nonce: b.nonce + 1 }));
      setAnnounce(collapsed ? 'Collapsed every file' : 'Expanded every file');
    },
    [files],
  );

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

  // ── Search in diff (spec §2 Lane C) ────────────────────────────────────────────────────────
  // The corpus is the LOADED FileReview data, never the DOM: a collapsed card, a row past the
  // 40-row cap and a card the windower hasn't mounted all hold matches the user must reach.
  const searchFiles = useMemo<ReviewSearchFile[]>(() => {
    if (!searchOpen) return NO_SEARCH_FILES;
    return files.map((c) => {
      const d = effectiveDiffs.get(absOf(c.path));
      return { path: c.path, review: d ? (reviewOfDiff(d, ignoreWhitespace) ?? NO_HUNKS) : null };
    });
  }, [searchOpen, files, effectiveDiffs, absOf, ignoreWhitespace]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger.
  useEffect(() => {
    setMatchIndex(0);
  }, [queryKey]);

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
    const row = scrollerRef.current?.querySelector<HTMLElement>(
      `.rcard[data-path="${CSS.escape(rowTarget.path)}"] .rline[data-seq="${rowTarget.seq}"]`,
    );
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
    for (const c of mounted) {
      const card = el.querySelector(`.rcard[data-path="${CSS.escape(c.path)}"]`);
      if (!card) continue;
      for (const { index, match } of matchesByPath.get(c.path) ?? []) {
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
    const pending = files.filter((c) => !effectiveDiffs.has(absOf(c.path)));
    if (pending.length === 0) {
      setSearchAll(false);
      return;
    }
    for (const c of pending.slice(0, SEARCH_ALL_BATCH)) requestOnce(absOf(c.path));
  }, [searchAll, files, effectiveDiffs, absOf, requestOnce]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
  }, []);

  // The navigator highlights the file nearest the viewport top — derived from the SAME anchor
  // math the scroll-memory uses (no new observer). Null before the list/viewport are measured.
  const activePath =
    files.length > 0
      ? (computeReviewAnchor(scrollTop, files.length, heightOf, (i) => files[i].path)?.topPath ??
        null)
      : null;
  activePathRef.current = activePath;

  const activeIndex = activePath ? (pathIndex.get(activePath) ?? -1) : -1;
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

  const currentPath = current ? (files[current.fileIndex]?.path ?? null) : null;

  // The last reveal this effect actually landed. A card outside the window isn't in the DOM yet, so
  // the first pass only scrolls to it and the effect re-runs once the window change mounts it —
  // hence the window deps, and hence this guard, so an unrelated window change can't re-fire a
  // reveal that already happened and steal focus back.
  const revealedRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: view.startIndex/endIndex are the "did the card mount yet" trigger.
  useLayoutEffect(() => {
    if (cursor.reveal === 0 || revealedRef.current === cursor.reveal) return;
    if (!current || !currentPath) return;
    const card = scrollerRef.current?.querySelector<HTMLElement>(
      `.rcard[data-path="${CSS.escape(currentPath)}"]`,
    );
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
  }, [cursor.reveal, current, currentPath, scrollToFile, view.startIndex, view.endIndex]);

  // A clicked header is already on screen, so this moves the ring WITHOUT bumping `reveal` —
  // scrolling to what the user just clicked would only jerk the viewport.
  const setCurrentFromCard = useCallback(
    (path: string, hunkIndex: number) => {
      const fileIndex = pathIndex.get(path);
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
    if (!pathIndex.has(noteTarget.path)) return;
    landedNonceRef.current = noteTarget.nonce;
    scrollToFile(noteTarget.path);
    setAnnounce(`Opened the note on line ${noteTarget.line} of ${noteTarget.path}`);
  }, [noteTarget, pathIndex, scrollToFile]);

  const jumpToCurrent = useCallback(() => {
    if (!current || !currentPath) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `.rcard[data-path="${CSS.escape(currentPath)}"] .rhunk__jump[data-hunk="${current.hunkIndex}"]`,
    );
    // The header button already knows its own work line; clicking it is the same path a mouse takes.
    el?.click();
  }, [current, currentPath]);

  // `s` runs whichever primary action the header is actually showing; binding it to a button
  // that is not on screen would be worse than binding it to the one that is (Lane E plan, 14).
  const runCurrentHunkOp = useCallback(
    (op: HunkOp) => {
      if (!current || current.hunkIndex < 0) return;
      const change = files[current.fileIndex];
      if (!change) return;
      const diff = effectiveDiffs.get(absOf(change.path));
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
        stagedSide.has(change.path),
        conflictedSide.has(change.path) || diff.unmerged === true,
        ignoreWhitespace,
      );
      if (mode === 'blocked' || mode === 'unmerged' || mode === 'whitespace') {
        setAnnounce(blockedReason(mode));
        return;
      }
      if (op === 'discardHunk' && (mode === 'unstage' || change.kind === 'U')) {
        setAnnounce(discardTitle(mode, change.kind === 'U'));
        return;
      }
      // `s` means "the primary action this header is showing", so the mode rule is applied HERE
      // and nowhere else — the switch below stays a plain key→op mapping.
      const effective = op === 'stageHunk' && mode === 'unstage' ? 'unstageHunk' : op;
      void runHunkOp(effective, change, hunk);
    },
    [
      absOf,
      current,
      effectiveDiffs,
      files,
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
          if (currentPath) onToggleReviewed(currentPath);
          break;
        case 'openHunk':
          jumpToCurrent();
          break;
        case 'addNote': {
          // The `+` on the current hunk’s first noteable row — the same path a mouse takes.
          if (!currentPath) break;
          const card = scrollerRef.current?.querySelector<HTMLElement>(
            `.rcard[data-path="${CSS.escape(currentPath)}"]`,
          );
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
      currentPath,
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

  // 5b/5e put a one-line summary of what the agent did under the header. Nothing here can write
  // that sentence, so the line carries real data or nothing at all — decision D17.
  const narrative =
    source?.kind === 'commit'
      ? (source.subject?.trim() ?? '') || null
      : source?.kind === 'range'
        ? `Comparing ${endpointLabel(source.base)} to ${endpointLabel(source.head)}`
        : null;

  // Nothing to accept or discard in a commit or a comparison — the footer is hidden, not
  // disabled (D10): a permanently greyed pair of primary actions reads as broken.
  const showFooter = !preloaded && files.length > 0 && onGitAction !== undefined;

  const navToggle = (
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
  );

  return (
    <div className="review docpage">
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

      <div className="review__body">
        {navOpen ? (
          <aside className="review__side">
            <div className="review__head">
              <span className="review__title">Review changes</span>
              {navToggle}
              <div className="review__actions">
                <button
                  type="button"
                  className="review__act review__collapseall"
                  aria-pressed={bulk.nonce > 0 && bulk.collapsed}
                  title="Collapse every file (Shift+E)"
                  onClick={() => setAllCollapsed(true)}
                >
                  Collapse all
                </button>
                <button
                  type="button"
                  className="review__act review__expandall"
                  aria-pressed={bulk.nonce > 0 && !bulk.collapsed}
                  title="Expand every file (E)"
                  onClick={() => setAllCollapsed(false)}
                >
                  Expand all
                </button>
                <button
                  type="button"
                  className="review__act review__wstoggle"
                  aria-pressed={ignoreWhitespace}
                  title="Ignore whitespace-only changes"
                  onClick={() => update({ reviewIgnoreWhitespace: !ignoreWhitespace })}
                >
                  Ignore whitespace
                </button>
                <button
                  type="button"
                  className="review__act review__helpbtn"
                  aria-pressed={helpOpen}
                  aria-haspopup="dialog"
                  title="Keyboard shortcuts (?)"
                  onClick={() => setHelpOpen((v) => !v)}
                >
                  ?
                </button>
              </div>
              <span className="review__sub">
                {files.length === 0 ? (
                  'No changes'
                ) : (
                  <>
                    {stat.files} file{stat.files === 1 ? '' : 's'}
                    {' · '}
                    <span className="diffstat--add">+{stat.insertions}</span>{' '}
                    <span className="diffstat--del">−{stat.deletions}</span>
                  </>
                )}
              </span>
            </div>
            {narrative && <p className="review__narrative">{narrative}</p>}
            {files.length > 0 && (
              <div className="review__progress">
                <div
                  className="review__meter"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.reviewed}
                  aria-label="Files reviewed"
                >
                  <div
                    className="review__meterfill"
                    style={{ width: `${progress.fraction * 100}%` }}
                  />
                </div>
                <span className="review__count">
                  {progress.reviewed} / {progress.total} reviewed
                </span>
              </div>
            )}
            <div className="review__filter">
              <input
                className="review__filterinput"
                type="text"
                placeholder="Filter files"
                aria-label="Filter files by path"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape' || fileFilter === '') return;
                  // Clearing the field IS this Esc; stop it before Review's chain reads it as
                  // "close search / close Review" (§2 Lane C).
                  e.preventDefault();
                  e.stopPropagation();
                  setFileFilter('');
                }}
              />
              {fileFilter.trim() !== '' && (
                <span className="review__filtercount">
                  {files.length} of {allFiles.length}
                </span>
              )}
            </div>
            <ReviewFileNav
              files={files}
              activePath={activePath}
              reviewed={reviewed}
              canMark={canMark}
              onPick={scrollToFile}
              onToggleReviewed={onToggleReviewed}
            />
            {showFooter && (
              <div className="review__foot">
                <button
                  type="button"
                  className="btn btn--primary review__accept"
                  title="Stage every changed file"
                  onClick={() => onGitAction?.({ op: 'stageAll' })}
                >
                  Accept all
                </button>
                <button
                  type="button"
                  className="btn review__discard"
                  title="Discard every working-tree change"
                  onClick={() => onGitAction?.({ op: 'discardAll' })}
                >
                  Discard
                </button>
              </div>
            )}
            {/* Its own row BELOW the footer, not inside it: the footer is gated on there being
                working-tree actions to take, and notes are worth handing over on a commit
                review too. */}
            {repoNotes.length > 0 && (
              <div className="review__handoff">
                <button
                  type="button"
                  className="btn review__send"
                  disabled={handoff.disabled || !notesReady}
                  aria-disabled={handoff.disabled || !notesReady}
                  aria-describedby={handoffHintId}
                  title={handoff.title}
                  onClick={onHandoff}
                >
                  {handoff.label}
                </button>
                <span id={handoffHintId} className="sr-only">
                  {handoff.title}
                </span>
              </div>
            )}
          </aside>
        ) : (
          <div className="review__rail">{navToggle}</div>
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
                          ? retryRangeDiff(sessionId, source.base, source.head)
                          : commitMode && source?.kind === 'commit'
                            ? retryCommitDiff(sessionId, source.sha, commitRepoRoot)
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
                  mode={hunkButtonMode(
                    scope,
                    stagedSide.has(c.path),
                    conflictedSide.has(c.path) ||
                      effectiveDiffs.get(absOf(c.path))?.unmerged === true,
                    ignoreWhitespace,
                  )}
                  hunkOpsAvailable={hunkOpsAvailable}
                  onHunkOp={runHunkOp}
                  onOpenDiff={onOpenDiff}
                  reviewed={reviewed.has(c.path)}
                  canMark={canMark(c.path)}
                  onToggleReviewed={onToggleReviewed}
                  revealNonce={reveal.path === c.path ? reveal.nonce : 0}
                  revealShowAll={reveal.showAll}
                  bulkCollapsed={bulk.collapsed}
                  bulkNonce={bulk.nonce}
                  ignoreWhitespace={ignoreWhitespace}
                  isCurrentFile={c.path === currentPath}
                  currentHunkIndex={c.path === currentPath ? (current?.hunkIndex ?? -1) : -1}
                  onSetCurrent={setCurrentFromCard}
                  onHunkCount={reportHunkCount}
                  notes={notesByPath.get(c.path) ?? EMPTY_NOTES}
                  notesReady={notesReady}
                  composer={composer?.path === c.path ? composer : null}
                  refusedMessage={refusedMessage}
                  onAddNote={openComposer}
                  onSaveNote={saveNote}
                  onCancelNote={requestCloseComposer}
                  onEditNote={editNote}
                  onResolveNote={resolveNote}
                  onDeleteNote={deleteNote}
                  onComposerDirty={onComposerDirty}
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
      {helpOpen && <ReviewKeyHelp onClose={() => setHelpOpen(false)} />}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
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

/**
 * The Review file list (design 5b/5e; decision D1 keeps it INSIDE the Review document rather
 * than taking over the sessions rail). One row per changed file: reviewed checkbox, status
 * badge, name over directory, `+n −m`. Clicking the name scrolls that file's card to the top.
 * A row with no line changes (binary/image, or a mode-only change) shows `—`, mirroring the
 * card header, which shows no `+/−` when both counts are 0.
 *
 * Windowed on the SAME `computeWindow` the card list uses: the review surface is the one most
 * likely to be pointed at a thousand-file diff, and a column that mounted every row would undo
 * the card list's virtualization. Rows are uniform, so one measured row calibrates all of them.
 */
function ReviewFileNav({
  files,
  activePath,
  reviewed,
  canMark,
  onPick,
  onToggleReviewed,
}: {
  files: ChangeDTO[];
  activePath: string | null;
  reviewed: ReadonlySet<string>;
  canMark: (path: string) => boolean;
  onPick: (path: string) => void;
  onToggleReviewed: (path: string) => void;
}) {
  const scrollerRef = useRef<HTMLElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowH, setRowH] = useState(NAV_ROW_H);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const estimate = useCallback(() => rowH, [rowH]);
  const win = computeWindow({
    count: files.length,
    scrollTop,
    viewportHeight,
    overscanPx: viewportHeight,
    estimate,
    measured: NO_MEASURED,
  });

  // Follow the card scroller: keep the highlighted row on screen without a DOM read, since the
  // active row is often not mounted (that is the whole point of the window).
  const activeIndex = activePath ? files.findIndex((f) => f.path === activePath) : -1;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || activeIndex < 0 || viewportHeight === 0) return;
    const top = activeIndex * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + viewportHeight) el.scrollTop = top + rowH - viewportHeight;
  }, [activeIndex, rowH, viewportHeight]);

  const mounted =
    win.endIndex >= win.startIndex ? files.slice(win.startIndex, win.endIndex + 1) : [];

  return (
    <nav
      ref={scrollerRef}
      className="review__nav"
      aria-label="Changed files"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <ul className="review__navlist">
        <li className="review__navpad" style={{ height: win.padTop }} aria-hidden />
        {mounted.map((c, i) => (
          <ReviewFileRow
            key={c.path}
            change={c}
            active={c.path === activePath}
            reviewed={reviewed.has(c.path)}
            canMark={canMark(c.path)}
            onPick={onPick}
            onToggleReviewed={onToggleReviewed}
            onMeasure={i === 0 ? setRowH : undefined}
          />
        ))}
        <li className="review__navpad" style={{ height: win.padBottom }} aria-hidden />
      </ul>
    </nav>
  );
}

function ReviewFileRow({
  change: c,
  active,
  reviewed,
  canMark,
  onPick,
  onToggleReviewed,
  onMeasure,
}: {
  change: ChangeDTO;
  active: boolean;
  reviewed: boolean;
  canMark: boolean;
  onPick: (path: string) => void;
  onToggleReviewed: (path: string) => void;
  /** Set on the first mounted row only — calibrates the window's uniform row height. */
  onMeasure?: (h: number) => void;
}) {
  const parts = c.path.split('/');
  const name = parts.pop() ?? c.path;
  const dir = parts.join('/');
  const noLines = c.added === 0 && c.removed === 0;

  const rowRef = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || !onMeasure) return;
    const report = () => onMeasure(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure]);

  return (
    <li
      ref={rowRef}
      className={`review__navrow${active ? ' review__navrow--active' : ''}${reviewed ? ' review__navrow--done' : ''}`}
      data-path={c.path}
    >
      <input
        type="checkbox"
        className="review__check"
        checked={reviewed}
        disabled={!canMark}
        title={canMark ? undefined : 'Loading diff…'}
        aria-label={`Mark ${c.path} reviewed`}
        onChange={() => onToggleReviewed(c.path)}
      />
      <button
        type="button"
        className="review__navbtn"
        aria-current={active ? 'true' : undefined}
        title={c.path}
        onClick={() => onPick(c.path)}
      >
        <span className={`change__kind change__kind--${c.kind}`}>{c.kind}</span>
        <span className="review__navpath">
          <span className="review__navname">{name}</span>
          {dir && <span className="review__navdir">{dir}</span>}
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
  change: ChangeDTO;
  abs: string;
  diff: FileDiffDTO | undefined;
  uiCache: Map<string, CardUiState>;
  onUiChange: (path: string, next: CardUiState) => void;
  onMeasure: (path: string, cardHeight: number) => void;
  onRequestOnce: (absPath: string) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
  mode: HunkButtonMode;
  /** False for a commit or a comparison: there is nothing to stage. */
  hunkOpsAvailable: boolean;
  onHunkOp: (op: HunkOp, change: ChangeDTO, hunk: ReviewHunk) => void;
  onOpenDiff: ((absPath: string) => void) | undefined;
  reviewed: boolean;
  canMark: boolean;
  onToggleReviewed: (path: string) => void;
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
  onSetCurrent: (path: string, hunkIndex: number) => void;
  onHunkCount: (path: string, count: number) => void;
  /** This file's notes, at whatever line they were last saved on. */
  notes: readonly ReviewNote[];
  /** False until the first `review:notes` push for this repo — the load gate (§4). */
  notesReady: boolean;
  /** The open composer, when it belongs to THIS file. */
  composer: ComposerTarget | null;
  /** Set when the repo is at its open-note cap; the composer refuses and says why. */
  refusedMessage: string | undefined;
  onAddNote: (
    path: string,
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
      onAddNote(change.path, side, line, snippetOf(lines[line - 1] ?? ''), anchor, origin);
    },
    [change.path, noteLines, onAddNote],
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
    const report = () => onMeasure(change.path, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [change.path, onMeasure]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the computed review, not to the callback's identity.
  useEffect(() => {
    if (review) onHunkCount(change.path, review.hunks.length);
  }, [change.path, review]);

  // Local interaction state seeded from (and written back to) the per-path cache so the card
  // looks exactly as the user left it after scrolling out and back.
  const [ui, setUiState] = useState<CardUiState>(
    () => uiCache.get(change.path) ?? emptyUi(bulkNonce > 0 && bulkCollapsed),
  );
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
        >
          <IconExternal size={13} />
        </button>
        {onOpenDiff && (
          <button
            type="button"
            className="rcard__split"
            title="Open this file as a side-by-side diff"
            onClick={() => onOpenDiff(abs)}
          >
            Split
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
          onClick={() => onToggleReviewed(change.path)}
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
          {diff?.unmerged ? (
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
                onSetCurrent={(hunkIndex) => onSetCurrent(change.path, hunkIndex)}
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
  change: ChangeDTO;
  mode: HunkButtonMode;
  hunkOpsAvailable: boolean;
  onHunkOp: (op: HunkOp, change: ChangeDTO, hunk: ReviewHunk) => void;
  ui: CardUiState;
  setUi: (updater: (prev: CardUiState) => CardUiState) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
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
  onJumpToHunk: (absPath: string, line: number) => void;
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
      {noteCount > 0 && (
        <span
          className="rline__notecount"
          aria-label={`${noteCount} note${noteCount === 1 ? '' : 's'}`}
        >
          {noteCount}
        </span>
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
    </pre>
  );
});

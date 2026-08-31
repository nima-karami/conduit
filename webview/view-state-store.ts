import type * as monaco from 'monaco-editor';

/**
 * Per-tab view-state store (spec 2026-06-30-tab-scroll-state-memory §3). A module
 * singleton keyed by `OpenDoc.id`, mirroring the `dirty-store.ts` / `project-index.ts`
 * seams: each viewer captures its scroll/view position here on scroll + unmount and
 * restores it on remount, so switching tabs no longer loses your place. The renderer is
 * the only owner — no host round-trip for the in-session MVP.
 *
 * Px `scrollTop` is only safe for FIXED-layout scrollers; the windowed Review list stores a
 * layout-independent anchor (top-visible card path + intra-card offset) instead, because a
 * raw offset lands on the wrong card once estimate-based heights resolve on a fresh mount
 * (spec §4). Monaco keeps its full view state (scroll + cursor + selection + folding) — one
 * cheap `saveViewState()` call (spec D2).
 *
 * Review's entry goes further and holds LIVE objects rather than snapshots (see
 * {@link ReviewListState}). An entry's lifetime is exactly its tab's — this is renderer memory,
 * and `markClosing` drops it — so the view can safely alias the maps instead of copying them
 * into and out of the store, which removes every window in which the two could disagree.
 */
export type ViewState =
  | { kind: 'scroll'; top: number; left?: number; selectedSha?: string }
  | { kind: 'monaco'; state: monaco.editor.ICodeEditorViewState | null }
  | { kind: 'reviewAnchor'; topPath: string; offset: number; list: ReviewListState };

/** How much of a fold's unchanged run is revealed, from the top and from the bottom. */
export interface ReviewFoldShown {
  topShown: number;
  botShown: number;
}

/** Per-card interaction state, keyed by path: which folds are open, whether the row cap is
 *  lifted, and whether the whole card is collapsed. */
export interface ReviewCardUi {
  folds: Map<number, ReviewFoldShown>;
  showRemaining: boolean;
  collapsed: boolean;
}

/**
 * Everything the Review list remembers besides its scroll anchor.
 *
 * `ui` and `measured` are the LIVE objects the view mutates — `uiCacheRef.current` and
 * `measuredRef.current` point AT them rather than copying, so nothing has to be captured before
 * the unmount a tab switch causes and there is no second copy that could drift. The rest is
 * React state, which cannot be aliased, so the view mirrors it here after every render.
 */
export interface ReviewListState {
  ui: Map<string, ReviewCardUi>;
  /** path → measured slot height (card border-box + gap). */
  measured: Map<string, number>;
  bulk: { collapsed: boolean; nonce: number };
  /** The navigator's fuzzy path filter. */
  filter: string;
  search: {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    all: boolean;
    matchIndex: number;
  };
  /** The keyboard cursor's hunk (`review-keymap.ts`'s `HunkRef`), structurally typed so this
   *  leaf module keeps no dependency on the view layer. */
  cursor: { fileIndex: number; hunkIndex: number } | null;
}

function freshReviewListState(): ReviewListState {
  return {
    ui: new Map(),
    measured: new Map(),
    bulk: { collapsed: false, nonce: 0 },
    filter: '',
    search: { open: false, query: '', caseSensitive: false, all: false, matchIndex: 0 },
    cursor: null,
  };
}

/** Debounce for live capture-on-scroll (spec §3 / D5). The synchronous unmount capture each
 *  viewer also runs is the safety net, so a switch inside this window never loses the position. */
export const VIEW_STATE_DEBOUNCE_MS = 120;

const store = new Map<string, ViewState>();

// Ids whose tab is being closed. A closing viewer's synchronous unmount capture would otherwise
// fire AFTER eviction and resurrect the entry (the close dispatch unmounts the viewer, whose
// teardown runs `setViewState`), so a reopened file would wrongly restore its old scroll. We
// tombstone the id on close to block that late write; the next mount-read (reopen) clears it.
const closing = new Set<string>();

export function getViewState(id: string): ViewState | undefined {
  closing.delete(id); // a fresh mount-read means the doc is live again — re-enable capture
  return store.get(id);
}

export function setViewState(id: string, state: ViewState): void {
  if (closing.has(id)) return; // ignore a dying viewer's post-eviction capture
  store.set(id, state);
}

/**
 * Merge a partial update into a doc's 'scroll' view-state, preserving the field NOT being
 * written. The git-history view captures its scroll offset (on scroll / unmount) and its
 * selected commit (on select) on independent events, so a plain overwrite would clobber
 * whichever it didn't set — the two must coexist in one entry. A `selectedSha` of null/undefined
 * clears the selection. A non-scroll or absent prior entry starts from a fresh scroll base.
 */
export function mergeScrollViewState(
  id: string,
  patch: { top?: number; selectedSha?: string | null },
): void {
  if (closing.has(id)) return; // same guard as setViewState — no post-eviction resurrection
  const prev = store.get(id);
  const next: Extract<ViewState, { kind: 'scroll' }> =
    prev?.kind === 'scroll' ? { ...prev } : { kind: 'scroll', top: 0 };
  if (patch.top !== undefined) next.top = patch.top;
  if ('selectedSha' in patch) {
    if (patch.selectedSha) next.selectedSha = patch.selectedSha;
    else delete next.selectedSha;
  }
  store.set(id, next);
}

/**
 * Merge a partial update into a Review doc's entry. Same shape of problem as
 * {@link mergeScrollViewState}: a plain overwrite would clobber a field it did not set.
 *
 * The reviewed set used to live here too (decision D9). It doesn't any more: marks are durable,
 * per-user state owned by the host (spec 2026-08-27-review-supercharge §2 Lane B), and a
 * tab-lifetime copy beside them could only disagree.
 */
export function mergeReviewViewState(
  id: string,
  patch: { anchor?: { topPath: string; offset: number } },
): void {
  if (closing.has(id)) return;
  const next = reviewEntry(store.get(id));
  if (patch.anchor) {
    next.topPath = patch.anchor.topPath;
    next.offset = patch.anchor.offset;
  }
  store.set(id, next);
}

function reviewEntry(prev: ViewState | undefined): Extract<ViewState, { kind: 'reviewAnchor' }> {
  return prev?.kind === 'reviewAnchor'
    ? { ...prev }
    : { kind: 'reviewAnchor', topPath: '', offset: 0, list: freshReviewListState() };
}

/**
 * Hand a mounting Review list the state bag for its doc, creating it on a first open. The bag is
 * returned by reference — see {@link ReviewListState} for why that matters.
 */
export function acquireReviewListState(id: string | undefined): ReviewListState {
  if (id === undefined) return freshReviewListState();
  closing.delete(id); // like getViewState: a fresh mount means the doc is live again
  const prev = store.get(id);
  if (prev?.kind === 'reviewAnchor') return prev.list;
  const entry = reviewEntry(prev);
  store.set(id, entry);
  return entry.list;
}

/**
 * A Review source change is a content reset (spec 2026-06-30 §4): the anchor goes, and so do the
 * per-path caches, because a fresh changeset with the previous one's collapse/fold/height state
 * is worse than none. Cleared IN PLACE — the mounted view holds these objects by reference.
 */
export function resetReviewViewState(id: string | undefined): void {
  const list = acquireReviewListState(id);
  list.ui.clear();
  list.measured.clear();
  if (id !== undefined) mergeReviewViewState(id, { anchor: { topPath: '', offset: 0 } });
}

/** Evict an id on tab/session close (spec §2 Evicted) and tombstone it so the closing viewer's
 *  final unmount capture can't resurrect it. Cleared by the next reopen's mount-read. */
export function markClosing(id: string): void {
  store.delete(id);
  closing.add(id);
}

/** Clamp a restored offset to the scroller's valid range so a shrunk/changed doc never
 *  strands the viewport past content end (spec §3 invariants, §4). */
export function clampScrollTop(top: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(max, Math.max(0, top));
}

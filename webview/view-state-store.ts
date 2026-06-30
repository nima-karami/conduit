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
 */
export type ViewState =
  | { kind: 'scroll'; top: number; left?: number }
  | { kind: 'monaco'; state: monaco.editor.ICodeEditorViewState | null }
  | { kind: 'reviewAnchor'; topPath: string; offset: number };

/** Debounce for live capture-on-scroll (spec §3 / D5). The synchronous unmount capture each
 *  viewer also runs is the safety net, so a switch inside this window never loses the position. */
export const VIEW_STATE_DEBOUNCE_MS = 120;

const store = new Map<string, ViewState>();

export function getViewState(id: string): ViewState | undefined {
  return store.get(id);
}

export function setViewState(id: string, state: ViewState): void {
  store.set(id, state);
}

/** Drop an id entirely — called when its tab/session closes (spec §2 Evicted). */
export function deleteViewState(id: string): void {
  store.delete(id);
}

/** Clamp a restored offset to the scroller's valid range so a shrunk/changed doc never
 *  strands the viewport past content end (spec §3 invariants, §4). */
export function clampScrollTop(top: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(max, Math.max(0, top));
}

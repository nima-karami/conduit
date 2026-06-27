// Pure windowing math for the Review view's outer card list (spec
// 2026-06-27-review-virtualization.md §3). DOM-free and deterministic so it is unit-testable
// in Node exactly like src/review-hunks.ts — the React layer feeds it scroll metrics and a
// measured-height cache and renders the resulting index range + spacer heights.

export interface WindowInput {
  /** Total cards in the list. */
  count: number;
  /** Current scroll offset of the scroller, in px. */
  scrollTop: number;
  /** Visible height of the scroller, in px. */
  viewportHeight: number;
  /** Extra px rendered above and below the viewport to absorb fling. */
  overscanPx: number;
  /** Estimated slot height for a card whose real height isn't measured yet. */
  estimate: (index: number) => number;
  /** index → measured slot height (the per-card cache). */
  measured: ReadonlyMap<number, number>;
}

export interface WindowResult {
  /** First mounted card (inclusive). */
  startIndex: number;
  /** Last mounted card (inclusive); `endIndex < startIndex` ⇒ nothing mounted. */
  endIndex: number;
  /** Spacer height before startIndex. */
  padTop: number;
  /** Spacer height after endIndex. */
  padBottom: number;
  /** Σ of all card heights — drives the scrollbar range. */
  totalHeight: number;
}

const EMPTY = { startIndex: 0, endIndex: -1, padTop: 0, padBottom: 0 } as const;

export function computeWindow(input: WindowInput): WindowResult {
  const { count, scrollTop, viewportHeight, overscanPx, estimate, measured } = input;

  const height = (i: number): number => measured.get(i) ?? estimate(i);

  // Prefix offsets in one pass; offsets[i] is the top edge of card i, total is the sum.
  const offsets = new Array<number>(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = total;
    total += height(i);
  }

  if (count === 0 || viewportHeight <= 0) return { ...EMPTY, totalHeight: total };

  const top = Math.max(0, scrollTop - overscanPx);
  const bottom = scrollTop + viewportHeight + overscanPx;

  // startIndex: first card whose bottom edge is past the window top. If every card is above
  // the window (scrolled beyond content) clamp to the last card so something always mounts.
  let start = 0;
  while (start < count && offsets[start] + height(start) <= top) start++;
  if (start >= count) start = count - 1;

  // endIndex: last card whose top edge is before the window bottom. Never less than start.
  let end = start;
  while (end + 1 < count && offsets[end + 1] < bottom) end++;

  const padTop = offsets[start];
  const padBottom = total - (offsets[end] + height(end));
  return { startIndex: start, endIndex: end, padTop, padBottom, totalHeight: total };
}

// ── Card height estimate ──────────────────────────────────────────────────────────────────
// Seeded from a file's added+removed rows (known before the diff lands) so the scrollbar is
// roughly right on first paint; measurement replaces it once a card mounts. Clamped so a
// pathological file can't blow the estimated scroll height out of proportion.

const ROW_PX = 17;
const CARD_CHROME_PX = 52;
const MIN_CARD_PX = 96;
const MAX_EST_PX = CARD_CHROME_PX + 50_000 * ROW_PX;

export function estimateCardHeight(added: number, removed: number): number {
  const raw = CARD_CHROME_PX + (added + removed) * ROW_PX;
  return Math.min(MAX_EST_PX, Math.max(MIN_CARD_PX, raw));
}

// ── Per-card row cap ────────────────────────────────────────────────────────────────────────
// Guards the one-giant-file case (spec Decision D2): cap the total rendered diff rows across a
// card's hunks, then a "Show remaining" expander reveals the rest. Pure so the cap walk is
// testable independent of React.

export function planRowCap(
  lineCounts: readonly number[],
  cap: number,
  expanded: boolean,
): { shown: number[]; remaining: number } {
  const total = lineCounts.reduce((a, b) => a + b, 0);
  if (expanded || total <= cap) return { shown: [...lineCounts], remaining: 0 };
  let budget = cap;
  const shown = lineCounts.map((n) => {
    const s = Math.min(n, budget);
    budget -= s;
    return s;
  });
  return { shown, remaining: total - shown.reduce((a, b) => a + b, 0) };
}

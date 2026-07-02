// Pure windowing math for the file Explorer's flat row list. Every visible tree row is the
// same fixed height (`.filerow` — padding + one text line), so the window is a plain index
// range from scrollTop, unlike Review's variable-height card windower (webview/review-window.ts).
// DOM-free and deterministic so it is unit-tested in Node.

// Rows to mount before the scroller's own height is known (viewportHeight 0). The tree scroller
// is unmounted while the search overlay is open and remounted on reveal, so a windowed slice
// may be computed for one render before the remount is measured — mounting a screenful (plus any
// pins) here guarantees something is on screen for measurement to self-correct against, and that
// a reveal target / open draft is never windowed away pre-measure. See the reveal-race fix.
const FALLBACK_ROWS = 30;

export interface FixedWindowInput {
  /** Total rows in the flattened, expanded tree. */
  count: number;
  /** Scroll offset of the scroller, in px. */
  scrollTop: number;
  /** Visible height of the scroller, in px. */
  viewportHeight: number;
  /** Measured height of one row, in px (all rows are equal height). */
  rowHeight: number;
  /** Extra rows mounted above and below the viewport to absorb fling. */
  overscan: number;
  /** Rows that must stay mounted regardless of scroll (e.g. an open inline draft or the
   *  revealed row). The range widens contiguously to include each; out-of-range values are
   *  ignored. Applied in every branch, including the pre-measure fallback. */
  pins?: readonly number[];
}

export interface FixedWindowResult {
  /** First mounted row (inclusive). */
  startIndex: number;
  /** Last mounted row (inclusive); `endIndex < startIndex` ⇒ nothing mounted. */
  endIndex: number;
  /** Spacer height before startIndex. */
  padTop: number;
  /** Spacer height after endIndex. */
  padBottom: number;
  /** count · rowHeight — drives the scrollbar range. */
  totalHeight: number;
}

export function computeFixedWindow(input: FixedWindowInput): FixedWindowResult {
  const { count, scrollTop, viewportHeight, rowHeight, overscan, pins } = input;
  const totalHeight = count * rowHeight;

  if (count <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: -1, padTop: 0, padBottom: 0, totalHeight };
  }

  // Never return an empty range when there are rows: an unmeasured scroller (viewportHeight 0)
  // still mounts a screenful so measurement can settle and pins below still apply.
  const effectiveViewport = viewportHeight > 0 ? viewportHeight : rowHeight * FALLBACK_ROWS;

  const first = Math.floor(scrollTop / rowHeight);
  const visibleRows = Math.ceil(effectiveViewport / rowHeight);
  let start = Math.max(0, first - overscan);
  let end = Math.min(count - 1, first + visibleRows + overscan);
  // Scrolled past the content (e.g. rows collapsed): clamp so something always mounts.
  if (start > count - 1) start = count - 1;

  if (pins) {
    for (const p of pins) {
      if (p < 0 || p >= count) continue;
      if (p < start) start = p;
      if (p > end) end = p;
    }
  }

  const padTop = start * rowHeight;
  const padBottom = (count - 1 - end) * rowHeight;
  return { startIndex: start, endIndex: end, padTop, padBottom, totalHeight };
}

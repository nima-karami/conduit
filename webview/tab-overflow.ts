// Pure, DOM-free helpers for the doc-tabs strip's overflow chevron and
// scroll-into-view behaviour.

/**
 * Sentinel `data-tabid` for the terminal/agent tab. Doc tabs use their own `id`;
 * the terminal tab has no doc id (`activeId === null`), so it gets this sentinel
 * to be targetable by the same `[data-tabid="…"]` query.
 */
export const TERMINAL_TABID = '__terminal__';

/**
 * Whether the scrollable strip overflows its visible width. Uses a 1px tolerance
 * because browsers report fractional widths, which would otherwise flicker the
 * chevron on sub-pixel rounding.
 */
export function isStripOverflowing(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

/**
 * Resolve the `data-tabid` to scroll into view for any tab kind. `null` is the
 * terminal/agent tab (mapped to the sentinel); any other value is a doc id,
 * returned unchanged.
 */
export function scrollTargetTabId(selected: string | null): string {
  return selected === null ? TERMINAL_TABID : selected;
}

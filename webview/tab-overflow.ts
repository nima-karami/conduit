/**
 * Pure, DOM-free helpers for the doc-tabs strip's overflow chevron and the
 * "scroll the chosen tab into view" behaviour. Kept free of React/DOM so they
 * can be unit-tested under the node test environment (no jsdom).
 */

/**
 * Sentinel `data-tabid` for the terminal/agent tab (the first button in the
 * strip). Doc tabs use their own `id` as the tabid; the terminal tab has no
 * doc id (its selection state is `activeId === null`), so it gets this stable
 * sentinel instead — letting the same `[data-tabid="…"]` query target it too.
 */
export const TERMINAL_TABID = '__terminal__';

/**
 * Whether the scrollable strip currently overflows its visible width.
 *
 * The chevron must show ONLY on overflow. Browsers report fractional
 * scroll/client widths, so a 1px tolerance avoids a chevron that flickers on
 * sub-pixel rounding when the content is effectively the same width.
 */
export function isStripOverflowing(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

/**
 * Resolve the `data-tabid` of the tab a dropdown selection should scroll into
 * view, for ANY tab kind. `null` is the terminal/agent tab (mapped to the
 * sentinel); any other value is a doc id and is returned unchanged.
 *
 * This makes the activate-from-dropdown scroll uniform: editor, terminal, and
 * agent tabs all resolve to a queryable `data-tabid`.
 */
export function scrollTargetTabId(selected: string | null): string {
  return selected === null ? TERMINAL_TABID : selected;
}

/**
 * Sticky-scroll helper for the terminal pane.
 *
 * xterm normally keeps the viewport pinned to the bottom while new output arrives, but
 * on a large/chunked write (e.g. Claude Code printing a big file edit) its internal
 * "is the user following?" heuristic can mis-fire: the view ends up stuck part-way up
 * and the user has to press End to reach the bottom. We fix that by deciding stickiness
 * ourselves — capture whether the viewport was at the bottom BEFORE a write, and if so
 * scroll back to the bottom AFTER it. If the user had deliberately scrolled up, we leave
 * them where they are (never yank them down).
 *
 * Pure + dependency-free so the decision is unit-tested without a real terminal.
 * `viewportY` is the index of the top visible row; `baseY` is that index when scrolled
 * fully down. The viewport can never be below the base, so equality means "at bottom".
 */
export function isViewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY;
}

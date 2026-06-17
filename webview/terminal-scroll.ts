/**
 * Sticky-scroll helper for the terminal pane.
 *
 * xterm's own "is the user following?" heuristic mis-fires on a large/chunked write (e.g.
 * Claude Code printing a big file edit), leaving the view stuck part-way up. We decide
 * stickiness ourselves: capture bottom-ness BEFORE a write and restore it AFTER, but
 * never yank down a user who had deliberately scrolled up.
 *
 * `viewportY` is the index of the top visible row; `baseY` is that index when scrolled
 * fully down. The viewport can never be below the base, so equality means "at bottom".
 */
export function isViewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY;
}

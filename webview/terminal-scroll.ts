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

/**
 * Whether WE should scroll the scrollback for a wheel event instead of letting xterm
 * handle it.
 *
 * The bug: when a TUI (Claude Code) enables mouse tracking (DEC 1000/1002/1003 — all
 * carry the wheel bit), xterm forwards wheel events to the app and stops scrolling its
 * own scrollback. A user who scrolled up in the *normal* buffer is then stranded — the
 * wheel does nothing and only a keystroke (`scrollOnUserInput`) snaps them to the bottom.
 * We take the wheel back exactly in that case. We do NOT interfere when no app grabbed
 * the mouse (xterm's native smooth scroll is better) or in the alternate screen, where
 * the wheel legitimately drives a full-screen app (less/vim). Shift is xterm's own
 * "don't scroll" modifier, so we defer on it too.
 */
export function shouldHandleWheelLocally(
  bufferType: 'normal' | 'alternate',
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any',
  shiftKey: boolean,
): boolean {
  return bufferType === 'normal' && mouseTrackingMode !== 'none' && !shiftKey;
}

/**
 * Lines to scroll for a wheel event, mirroring xterm's own `Viewport.getLinesScrolled`
 * so our takeover feels identical to its native scrolling. `partial` carries the
 * sub-line pixel remainder between calls (trackpads emit fractional pixel deltas): pass
 * the previous remainder in and feed the returned one back next time.
 */
export function wheelScrollLines(
  deltaY: number,
  deltaMode: number,
  rowHeight: number,
  rows: number,
  partial: number,
): { lines: number; partial: number } {
  if (deltaY === 0 || rowHeight <= 0) return { lines: 0, partial };
  if (deltaMode === WHEEL_DELTA_PIXEL) {
    const acc = partial + deltaY / rowHeight;
    const lines = Math.floor(Math.abs(acc)) * (acc > 0 ? 1 : -1);
    return { lines, partial: acc % 1 };
  }
  if (deltaMode === WHEEL_DELTA_PAGE) return { lines: deltaY * rows, partial };
  return { lines: deltaY, partial }; // WHEEL_DELTA_LINE
}

const WHEEL_DELTA_PIXEL = 0;
const WHEEL_DELTA_PAGE = 2;

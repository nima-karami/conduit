/**
 * Pure viewport-clamp positioning for the shared context menu.
 *
 * Given the requested open point (cursor), the measured menu box size, and the
 * viewport size, return the menu's top-left so that the whole box stays within
 * the viewport minus `margin` px on every edge whenever it fits. If the menu is
 * larger than the available space, the top-left is pinned to the margin (never
 * negative / off-screen at the top-left).
 *
 * Deterministic and DOM-free so it can be unit-tested in a node environment.
 */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export function clampMenuPosition(requested: Point, menu: Size, viewport: Size, margin = 8): Point {
  const maxX = viewport.width - menu.width - margin;
  const maxY = viewport.height - menu.height - margin;
  const x = Math.max(margin, Math.min(requested.x, maxX));
  const y = Math.max(margin, Math.min(requested.y, maxY));
  return { x, y };
}

/** A trigger element's box in viewport coordinates (i.e. `getBoundingClientRect()`). */
export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type PopoverAlign = 'start' | 'end'; // which edges line up: start = left/left, end = right/right
export type PopoverSide = 'below' | 'above';

/**
 * Requested open point for a popover anchored to a trigger element's rect, on either side. The
 * returned point is in the same (viewport) coordinate space as the rect, ready to hand to
 * `clampMenuPosition` which keeps it on-screen.
 */
export function anchorPopover(
  rect: Rect,
  menu: Size,
  opts: { align: PopoverAlign; side: PopoverSide; gap: number },
): Point {
  const x = opts.align === 'end' ? rect.right - menu.width : rect.left;
  const y = opts.side === 'below' ? rect.bottom + opts.gap : rect.top - opts.gap - menu.height;
  return { x, y };
}

/**
 * A menu hung from a trigger button, right edges aligned. It goes through `anchor` so the Popover
 * aligns it by its MEASURED width: a guessed width misses the button by the difference, which
 * differs per theme. `x`/`y` only satisfy `MenuState`; anchor mode never reads them.
 */
export function triggerMenu(
  rect: Rect,
  side: PopoverSide = 'below',
): { x: number; y: number; anchor: Rect; side: PopoverSide } {
  return { x: rect.left, y: rect.bottom, anchor: rect, side };
}

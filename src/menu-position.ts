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

/**
 * Requested open point for a menu anchored to a trigger button (e.g. the
 * sessions three-dot overflow). The menu hangs just below the trigger and its
 * right edge lines up with the trigger's right edge, so a `menuWidth`-wide menu
 * stays over the (narrow) panel rather than spilling rightward. `gap` is the
 * vertical space between the trigger and the menu.
 *
 * The returned point is in the same (viewport) coordinate space as the rect,
 * ready to hand to `clampMenuPosition` which keeps it on-screen. Anchoring uses
 * the live rect — never a hardcoded/centered position — so the menu always
 * tracks its button.
 */
export function anchorMenuToRect(rect: Rect, menuWidth: number, gap = 4): Point {
  return { x: rect.right - menuWidth, y: rect.bottom + gap };
}

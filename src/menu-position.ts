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

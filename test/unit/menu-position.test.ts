import { describe, expect, it } from 'vitest';
import { anchorMenuToRect, clampMenuPosition } from '../../src/menu-position';

// Pure viewport-clamp positioning for the shared context menu.
// Given the requested cursor position, the measured menu size, and the
// viewport size, it returns a top-left that keeps the menu on-screen with an
// 8px margin whenever it fits.
describe('clampMenuPosition', () => {
  const VIEWPORT = { width: 1000, height: 800 };

  it('leaves a position untouched when the menu fits at the cursor', () => {
    const pos = clampMenuPosition({ x: 100, y: 100 }, { width: 200, height: 300 }, VIEWPORT);
    expect(pos).toEqual({ x: 100, y: 100 });
  });

  it('shifts left/up so the menu does not overflow the right/bottom edge', () => {
    const pos = clampMenuPosition({ x: 980, y: 780 }, { width: 200, height: 300 }, VIEWPORT);
    // right edge: 1000 - 200 - 8 = 792 ; bottom edge: 800 - 300 - 8 = 492
    expect(pos).toEqual({ x: 792, y: 492 });
  });

  it('pins the top-left to the 8px margin, never negative', () => {
    const pos = clampMenuPosition({ x: 0, y: 0 }, { width: 200, height: 300 }, VIEWPORT);
    expect(pos).toEqual({ x: 8, y: 8 });
  });

  it('pins top-left to the margin when the menu is larger than the viewport', () => {
    const pos = clampMenuPosition({ x: 500, y: 500 }, { width: 2000, height: 2000 }, VIEWPORT);
    // min(500, 1000-2000-8 = -1008) = -1008, then max(8, -1008) = 8
    expect(pos).toEqual({ x: 8, y: 8 });
  });

  it('clamps each axis independently', () => {
    const pos = clampMenuPosition({ x: 980, y: 100 }, { width: 200, height: 300 }, VIEWPORT);
    expect(pos).toEqual({ x: 792, y: 100 });
  });

  it('uses a custom margin when provided', () => {
    const pos = clampMenuPosition({ x: 0, y: 0 }, { width: 200, height: 300 }, VIEWPORT, 16);
    expect(pos).toEqual({ x: 16, y: 16 });
  });
});

// Anchors a menu to a trigger button's viewport rect (its getBoundingClientRect).
// The menu hangs just below the trigger and right-aligns to the trigger's right
// edge. The result is a *requested* point in viewport space, fed to
// clampMenuPosition for on-screen clamping.
describe('anchorMenuToRect', () => {
  // A trigger button sitting at the top-right of a narrow sidebar.
  const TRIGGER = { left: 220, right: 260, top: 60, bottom: 84 };

  it('right-aligns the menu to the trigger and drops it below by the gap', () => {
    const p = anchorMenuToRect(TRIGGER, 200);
    // x: right(260) - width(200) = 60 ; y: bottom(84) + gap(4) = 88
    expect(p).toEqual({ x: 60, y: 88 });
  });

  it('honors a custom gap', () => {
    const p = anchorMenuToRect(TRIGGER, 200, 10);
    expect(p).toEqual({ x: 60, y: 94 });
  });

  it('tracks the trigger position (not a fixed/centered spot)', () => {
    const moved = { left: 500, right: 540, top: 300, bottom: 324 };
    const p = anchorMenuToRect(moved, 200);
    expect(p).toEqual({ x: 340, y: 328 });
  });

  it('returns the trigger-derived point as-is; clamping is a separate step', () => {
    // A menu wider than the trigger's right offset yields a negative x, which the
    // anchor does NOT clamp — clampMenuPosition is responsible for that.
    const p = anchorMenuToRect(TRIGGER, 400);
    expect(p.x).toBe(260 - 400);
    const onScreen = clampMenuPosition(
      p,
      { width: 400, height: 200 },
      { width: 1000, height: 800 },
    );
    expect(onScreen).toEqual({ x: 8, y: 88 });
  });
});

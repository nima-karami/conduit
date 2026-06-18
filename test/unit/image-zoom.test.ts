import { describe, expect, it } from 'vitest';
import {
  BUTTON_STEP,
  canPan,
  clampPan,
  clampZoom,
  fitScale,
  MAX_ZOOM,
  panBounds,
  panToKeepPointer,
  stepZoom,
  WHEEL_STEP,
  zoomPercent,
} from '../../webview/image-zoom';

describe('clampZoom', () => {
  it('clamps to [fit, MAX_ZOOM]', () => {
    expect(clampZoom(0.1, 0.5)).toBe(0.5);
    expect(clampZoom(100, 0.5)).toBe(MAX_ZOOM);
    expect(clampZoom(2, 0.5)).toBe(2);
  });

  it('never lets the floor exceed MAX_ZOOM (huge fit pane)', () => {
    // A tiny image whose "fit" would be >8× is still capped at MAX_ZOOM.
    expect(clampZoom(20, 12)).toBe(MAX_ZOOM);
  });
});

describe('stepZoom', () => {
  it('wheel step grows/shrinks by 10% multiplicatively', () => {
    expect(stepZoom(1, 1, WHEEL_STEP, 0.5)).toBeCloseTo(1.1, 5);
    expect(stepZoom(1.1, -1, WHEEL_STEP, 0.5)).toBeCloseTo(1, 5);
  });

  it('button step grows by 25%', () => {
    expect(stepZoom(2, 1, BUTTON_STEP, 0.5)).toBeCloseTo(2.5, 5);
  });

  it('clamps at MAX_ZOOM and at fit', () => {
    expect(stepZoom(MAX_ZOOM, 1, BUTTON_STEP, 0.5)).toBe(MAX_ZOOM);
    expect(stepZoom(0.5, -1, BUTTON_STEP, 0.5)).toBe(0.5);
  });
});

describe('panBounds / clampPan / canPan', () => {
  const natural = { w: 1000, h: 1000 };
  const pane = { w: 400, h: 400 };

  it('bounds are half the overflow per axis', () => {
    // At 1× a 1000px image in a 400px pane overflows by 600 → ±300.
    expect(panBounds(natural, pane, 1)).toEqual({ x: 300, y: 300 });
  });

  it('no pan room when the scaled image fits the pane', () => {
    expect(panBounds(natural, pane, 0.4)).toEqual({ x: 0, y: 0 });
    expect(canPan(natural, pane, 0.4)).toBe(false);
    expect(canPan(natural, pane, 1)).toBe(true);
  });

  it('clamps a pan offset to its bounds', () => {
    expect(clampPan({ x: 9999, y: -9999 }, natural, pane, 1)).toEqual({ x: 300, y: -300 });
    expect(clampPan({ x: 50, y: 50 }, natural, pane, 1)).toEqual({ x: 50, y: 50 });
  });
});

describe('panToKeepPointer', () => {
  it('keeps the cursor content-point stationary as zoom changes', () => {
    // Pointer 100px right of center, image at pan 0, zoom 1 → content point at +100.
    // After zooming to 2×, that content point must still sit under the pointer.
    const pan0 = { x: 0, y: 0 };
    const pointer = { x: 100, y: 0 };
    const newPan = panToKeepPointer(pan0, pointer, 1, 2);
    // content under cursor before = (pointer - pan)/old = 100
    // after: pointer should equal content*new + newPan → 100 = 100*2 + newPan.x
    expect(newPan.x).toBeCloseTo(-100, 5);
    // Verify invariant directly.
    const contentBefore = (pointer.x - pan0.x) / 1;
    const screenAfter = contentBefore * 2 + newPan.x;
    expect(screenAfter).toBeCloseTo(pointer.x, 5);
  });

  it('pointer at center keeps pan at center', () => {
    expect(panToKeepPointer({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 4)).toEqual({ x: 0, y: 0 });
  });
});

describe('fitScale', () => {
  it('never upscales a small image past 1x', () => {
    expect(fitScale({ w: 16, h: 16 }, { w: 400, h: 400 })).toBe(1);
  });

  it('downscales a large image to fit the smaller axis', () => {
    expect(fitScale({ w: 2000, h: 1000 }, { w: 400, h: 400 })).toBeCloseTo(0.2, 5);
  });

  it('degrades to 1 on zero/invalid dimensions', () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 400, h: 400 })).toBe(1);
  });
});

describe('zoomPercent', () => {
  it('formats as a whole-number percentage', () => {
    expect(zoomPercent(1)).toBe('100%');
    expect(zoomPercent(0.5)).toBe('50%');
    expect(zoomPercent(2.345)).toBe('235%');
  });
});

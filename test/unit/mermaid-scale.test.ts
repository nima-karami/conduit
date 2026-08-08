import { describe, expect, it } from 'vitest';
import {
  INLINE_MAX_HEIGHT_FRACTION,
  inlineDiagramScale,
  MIN_INLINE_SCALE,
} from '../../webview/mermaid-scale';

/** The measured Markdown column and viewport of the diagnostic walk (1600×1000 window). */
const COLUMN = 864;
const MAX_H = 700;

const scale = (
  w: number,
  h: number,
  over: Partial<Parameters<typeof inlineDiagramScale>[0]> = {},
) =>
  inlineDiagramScale({
    natural: { w, h },
    columnWidth: COLUMN,
    maxHeight: MAX_H,
    minScale: MIN_INLINE_SCALE,
    ...over,
  });

describe('inlineDiagramScale — constants', () => {
  it('floors legibility at 0.35 and the height cap at 70% of the viewport', () => {
    expect(MIN_INLINE_SCALE).toBe(0.35);
    expect(INLINE_MAX_HEIGHT_FRACTION).toBe(0.7);
  });
});

describe('inlineDiagramScale — fits as-is', () => {
  it('renders 1:1 when the diagram is smaller than the column and the cap', () => {
    expect(scale(618, 382)).toEqual({
      scale: 1,
      width: 618,
      height: 382,
      scrolls: false,
      capped: false,
    });
  });

  it('never upscales a tiny diagram to fill the column', () => {
    expect(scale(111, 174).scale).toBe(1);
  });

  it('renders 1:1 when the diagram is exactly the column width', () => {
    const r = scale(COLUMN, 200);
    expect(r.scale).toBe(1);
    expect(r.scrolls).toBe(false);
  });
});

describe('inlineDiagramScale — width constrained', () => {
  it('scales down to the column width', () => {
    const r = scale(1600, 460, { columnWidth: 800 });
    expect(r.scale).toBeCloseTo(0.5, 6);
    expect(r.width).toBeCloseTo(800, 6);
    expect(r.height).toBeCloseTo(230, 6);
    expect(r.scrolls).toBe(false);
    expect(r.capped).toBe(false);
  });
});

describe('inlineDiagramScale — height constrained', () => {
  it('scales down to the height cap and reports capped', () => {
    const r = scale(800, 1526);
    expect(r.scale).toBeCloseTo(MAX_H / 1526, 6);
    expect(r.height).toBeCloseTo(MAX_H, 6);
    expect(r.width).toBeLessThan(COLUMN);
    expect(r.capped).toBe(true);
    expect(r.scrolls).toBe(false);
  });

  it('does not report capped for a diagram that fits at 1:1 within the cap', () => {
    expect(scale(400, MAX_H).capped).toBe(false);
  });

  it('ignores a non-positive cap rather than collapsing the diagram', () => {
    const r = scale(400, 5000, { maxHeight: 0 });
    expect(r.scale).toBe(1);
    expect(r.capped).toBe(false);
  });
});

describe('inlineDiagramScale — both axes constrained', () => {
  it('takes the smaller of the two fits', () => {
    const r = scale(1000, 1000);
    expect(COLUMN / 1000).toBeLessThan(1);
    expect(r.scale).toBeCloseTo(Math.min(COLUMN / 1000, MAX_H / 1000), 6);
    expect(r.height).toBeCloseTo(MAX_H, 6);
    expect(r.capped).toBe(true);
  });
});

describe('inlineDiagramScale — legibility floor', () => {
  it('stops at the floor and scrolls instead of smearing an extreme aspect', () => {
    const r = scale(9820, 70);
    expect(r.scale).toBe(MIN_INLINE_SCALE);
    expect(r.width).toBeCloseTo(9820 * MIN_INLINE_SCALE, 6);
    expect(r.height).toBeCloseTo(24.5, 6);
    expect(r.scrolls).toBe(true);
  });

  it('keeps an enormous diagram at the floor rather than 0.07x', () => {
    const r = scale(13176, 798);
    expect(r.scale).toBe(MIN_INLINE_SCALE);
    expect(r.scrolls).toBe(true);
  });

  it('scrolls a very tall diagram whose floor height still exceeds the cap', () => {
    const r = scale(134, 6206);
    expect(r.scale).toBe(MIN_INLINE_SCALE);
    expect(r.height).toBeCloseTo(6206 * MIN_INLINE_SCALE, 6);
    expect(r.scrolls).toBe(true);
    expect(r.capped).toBe(true);
  });

  it('honours a caller floor of 1 by never scaling down at all', () => {
    const r = scale(9820, 70, { minScale: 1 });
    expect(r.scale).toBe(1);
    expect(r.width).toBe(9820);
    expect(r.scrolls).toBe(true);
  });

  it('honours a caller floor of 0 by fitting the column exactly', () => {
    const r = scale(9820, 70, { minScale: 0 });
    expect(r.width).toBeCloseTo(COLUMN, 6);
    expect(r.scrolls).toBe(false);
  });
});

describe('inlineDiagramScale — degenerate input', () => {
  it('is a no-op for a zero-sized diagram', () => {
    expect(scale(0, 0)).toEqual({
      scale: 1,
      width: 0,
      height: 0,
      scrolls: false,
      capped: false,
    });
  });

  it('is a no-op for negative dimensions', () => {
    expect(scale(-100, -50)).toEqual({
      scale: 1,
      width: 0,
      height: 0,
      scrolls: false,
      capped: false,
    });
  });

  it('is a no-op for a non-finite dimension', () => {
    expect(scale(Number.NaN, 100).scale).toBe(1);
    expect(scale(100, Number.POSITIVE_INFINITY).width).toBe(0);
  });

  it('leaves the diagram at 1:1 while the column is still unmeasured', () => {
    const r = scale(9820, 70, { columnWidth: 0 });
    expect(r.scale).toBe(1);
    expect(r.width).toBe(9820);
    expect(r.scrolls).toBe(false);
  });
});

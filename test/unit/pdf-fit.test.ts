import { describe, expect, it } from 'vitest';
import {
  clampScale,
  fitScaleForPages,
  MAX_SCALE,
  MIN_SCALE,
  PAGE_MARGIN,
  type PageSize,
} from '../../webview/pdf-fit';

const LETTER: PageSize = { width: 612, height: 792 };
const WIDE: PageSize = { width: 1584, height: 612 };
const CONTAINER = { width: 935, height: 800 };
const availW = CONTAINER.width - PAGE_MARGIN;
const availH = CONTAINER.height - PAGE_MARGIN;

describe('fitScaleForPages — fit width', () => {
  it('scales the single page to the available width', () => {
    expect(fitScaleForPages([LETTER], CONTAINER, 'width')).toBeCloseTo(availW / 612, 5);
  });

  it('uses the widest page, not the first one', () => {
    expect(fitScaleForPages([LETTER, LETTER, WIDE], CONTAINER, 'width')).toBeCloseTo(
      availW / 1584,
      5,
    );
  });
});

describe('fitScaleForPages — fit page', () => {
  it('fits the largest bounding box, whichever pages contribute the edges', () => {
    const tall: PageSize = { width: 100, height: 1000 };
    const flat: PageSize = { width: 2000, height: 100 };
    // Height-constrained: only the box (2000×1000) yields 0.5 — taking either page whole
    // would fit on both axes and give ~1.98.
    expect(fitScaleForPages([tall, flat], { width: 4000, height: 548 }, 'page')).toBeCloseTo(
      500 / 1000,
      5,
    );
  });

  it('is the smaller of the width and height ratios', () => {
    expect(fitScaleForPages([LETTER, WIDE], CONTAINER, 'page')).toBeCloseTo(
      Math.min(availW / 1584, availH / 792),
      5,
    );
  });
});

describe('fitScaleForPages — rotation', () => {
  it('swaps the page bounds at 90°', () => {
    expect(fitScaleForPages([LETTER], CONTAINER, 'width', 90)).toBeCloseTo(availW / 792, 5);
  });

  it('swaps the page bounds at 270°', () => {
    expect(fitScaleForPages([LETTER], CONTAINER, 'width', 270)).toBeCloseTo(availW / 792, 5);
  });

  it('leaves the bounds alone at 180°', () => {
    expect(fitScaleForPages([LETTER], CONTAINER, 'width', 180)).toBe(
      fitScaleForPages([LETTER], CONTAINER, 'width', 0),
    );
  });

  it('picks the widest page against the rotated bounds', () => {
    // Rotated, the 792-tall LETTER is wider on screen than the 612-tall WIDE page.
    expect(fitScaleForPages([LETTER, WIDE], CONTAINER, 'width', 90)).toBeCloseTo(availW / 792, 5);
  });
});

describe('fitScaleForPages — clamping', () => {
  it('never exceeds MAX_SCALE', () => {
    expect(fitScaleForPages([{ width: 10, height: 10 }], CONTAINER, 'width')).toBe(MAX_SCALE);
  });

  it('never drops below MIN_SCALE', () => {
    expect(fitScaleForPages([{ width: 20000, height: 20000 }], CONTAINER, 'width')).toBe(MIN_SCALE);
  });

  it('fits a 5000 pt page rather than clamping it', () => {
    // Such a page needs ~0.18× in a 935 px viewport; a floor above that is why the fixture
    // still opened overflowing.
    expect(fitScaleForPages([{ width: 5000, height: 5000 }], CONTAINER, 'width')).toBeCloseTo(
      availW / 5000,
      5,
    );
  });
});

describe('fitScaleForPages — degenerate input', () => {
  it('returns null for an empty document', () => {
    expect(fitScaleForPages([], CONTAINER, 'width')).toBeNull();
  });

  it('returns null when every page measures zero', () => {
    expect(fitScaleForPages([{ width: 0, height: 0 }], CONTAINER, 'width')).toBeNull();
  });

  it('returns null when the container is narrower than the page margins', () => {
    expect(fitScaleForPages([LETTER], { width: PAGE_MARGIN, height: 800 }, 'width')).toBeNull();
  });

  it('returns null for fit page when the container is shorter than the page margins', () => {
    expect(fitScaleForPages([LETTER], { width: 935, height: PAGE_MARGIN }, 'page')).toBeNull();
  });
});

describe('clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeFixedWindow,
  computeSectionWindow,
  type FixedWindowInput,
} from '../../webview/tree-window';

/** Build a FixedWindowInput with sane defaults; override what a case cares about. */
const input = (over: Partial<FixedWindowInput> = {}): FixedWindowInput => ({
  count: 0,
  scrollTop: 0,
  viewportHeight: 500,
  rowHeight: 25,
  overscan: 0,
  ...over,
});

describe('computeFixedWindow', () => {
  it('count 0 → empty range, everything zero', () => {
    const r = computeFixedWindow(input({ count: 0 }));
    expect(r).toEqual({ startIndex: 0, endIndex: -1, padTop: 0, padBottom: 0, totalHeight: 0 });
  });

  it('rowHeight 0 → nothing mounts (avoids divide-by-zero)', () => {
    const r = computeFixedWindow(input({ count: 10, rowHeight: 0 }));
    expect(r.endIndex).toBe(-1);
    expect(r.totalHeight).toBe(0);
  });

  it('list shorter than viewport → whole list, no spacers', () => {
    const r = computeFixedWindow(input({ count: 5, viewportHeight: 500, rowHeight: 25 }));
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(4);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe(0);
    expect(r.totalHeight).toBe(125);
  });

  it('top of a long list mounts only the leading rows (overscan 0)', () => {
    const r = computeFixedWindow(input({ count: 1000, viewportHeight: 500, rowHeight: 25 }));
    // 500px / 25px = 20 rows visible: 0..20 inclusive (ceil covers the partial 21st slot edge).
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(20);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((1000 - 21) * 25);
    expect(r.totalHeight).toBe(25000);
  });

  it('scrolled into the middle mounts only the intersecting slice', () => {
    const r = computeFixedWindow(
      input({ count: 1000, scrollTop: 5000, viewportHeight: 500, rowHeight: 25, overscan: 0 }),
    );
    // first = floor(5000/25) = 200; 20 visible rows → 200..220.
    expect(r.startIndex).toBe(200);
    expect(r.endIndex).toBe(220);
    expect(r.padTop).toBe(200 * 25);
    expect(r.padBottom).toBe((1000 - 221) * 25);
  });

  it('overscan pads the range on both sides and clamps at the edges', () => {
    const mid = computeFixedWindow(
      input({ count: 1000, scrollTop: 5000, viewportHeight: 500, rowHeight: 25, overscan: 8 }),
    );
    expect(mid.startIndex).toBe(192);
    expect(mid.endIndex).toBe(228);

    const top = computeFixedWindow(
      input({ count: 1000, scrollTop: 0, viewportHeight: 500, rowHeight: 25, overscan: 8 }),
    );
    expect(top.startIndex).toBe(0);
    expect(top.endIndex).toBe(28);
    expect(top.padTop).toBe(0);
  });

  it('scrolled past the end clamps so at least the last row mounts', () => {
    const r = computeFixedWindow(
      input({ count: 10, scrollTop: 100_000, viewportHeight: 500, rowHeight: 25 }),
    );
    expect(r.startIndex).toBe(9);
    expect(r.endIndex).toBe(9);
    expect(r.padTop).toBe(225);
    expect(r.padBottom).toBe(0);
  });

  it('padTop + rendered rows + padBottom always equals totalHeight', () => {
    const r = computeFixedWindow(
      input({ count: 1000, scrollTop: 3333, viewportHeight: 480, rowHeight: 25, overscan: 5 }),
    );
    const rendered = (r.endIndex - r.startIndex + 1) * 25;
    expect(r.padTop + rendered + r.padBottom).toBe(r.totalHeight);
  });

  it('a pin below the window widens the range down to include it', () => {
    const r = computeFixedWindow(
      input({ count: 1000, scrollTop: 0, viewportHeight: 500, rowHeight: 25, pins: [100] }),
    );
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(100);
    expect(r.padBottom).toBe((1000 - 101) * 25);
  });

  it('a pin above the window widens the range up to include it', () => {
    const r = computeFixedWindow(
      input({ count: 1000, scrollTop: 5000, viewportHeight: 500, rowHeight: 25, pins: [10] }),
    );
    expect(r.startIndex).toBe(10);
    expect(r.padTop).toBe(250);
    expect(r.endIndex).toBe(220);
  });

  it('out-of-range pins are ignored', () => {
    const r = computeFixedWindow(
      input({ count: 10, viewportHeight: 500, rowHeight: 25, pins: [-1, 99] }),
    );
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(9);
  });

  // Reveal-race regressions: the scroller is remounted (a new element) when search→reveal closes
  // the overlay, so a window is computed for one render before the fresh element is measured
  // (viewportHeight 0). The pre-measure branch must still mount rows — including any pin — or the
  // revealed row never mounts and `.filerow--revealed` never appears (the bug that got the prior
  // attempt reverted).
  it('viewportHeight 0 with rows → nonzero fallback slice, not an empty range', () => {
    const r = computeFixedWindow(input({ count: 1000, viewportHeight: 0, rowHeight: 25 }));
    expect(r.endIndex).toBeGreaterThanOrEqual(r.startIndex);
    expect(r.startIndex).toBe(0);
    // 30-row fallback screenful mounts far fewer than the full 1000.
    expect(r.endIndex).toBeGreaterThan(0);
    // 30-row fallback (+0 overscan here) mounts far fewer than the full 1000.
    expect(r.endIndex).toBeLessThan(200);
    expect(r.totalHeight).toBe(25000);
  });

  it('viewportHeight 0 short list → whole list mounts', () => {
    const r = computeFixedWindow(input({ count: 10, viewportHeight: 0, rowHeight: 25 }));
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(9);
    expect(r.totalHeight).toBe(250);
  });

  it('viewportHeight 0 with a far pin → the pin still mounts (reveal target survives remount)', () => {
    const r = computeFixedWindow(
      input({ count: 1000, viewportHeight: 0, rowHeight: 25, pins: [500] }),
    );
    expect(r.startIndex).toBeLessThanOrEqual(500);
    expect(r.endIndex).toBe(500);
  });
});

describe('computeSectionWindow', () => {
  const mounted = (r: { startIndex: number; endIndex: number }) =>
    Math.max(0, r.endIndex - r.startIndex + 1);

  it('section at top ≡ computeFixedWindow', () => {
    for (const scrollTop of [0, 37, 400, 2000]) {
      const base = input({ count: 200, scrollTop, overscan: 8 });
      expect(computeSectionWindow({ ...base, sectionTop: 0 })).toEqual(computeFixedWindow(base));
    }
  });

  it('section starting mid-viewport mounts from 0 with the reduced viewport', () => {
    const r = computeSectionWindow({
      ...input({ count: 200, scrollTop: 100, viewportHeight: 500, overscan: 4 }),
      sectionTop: 350,
    });
    // 250px of the section is visible: 10 rows + 4 overscan below, nothing above row 0.
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(14);
    expect(r.padTop).toBe(0);
    expect(r.padTop + r.padBottom + mounted(r) * 25).toBe(r.totalHeight);
  });

  it('section scrolled past mounts the tail window', () => {
    const r = computeSectionWindow({
      ...input({ count: 100, scrollTop: 3000, viewportHeight: 500, overscan: 2 }),
      sectionTop: 1000,
    });
    // local scrollTop 2000 → first row 80; clamped at the last row.
    expect(r.startIndex).toBe(78);
    expect(r.endIndex).toBe(99);
    expect(r.padBottom).toBe(0);
  });

  it('fully off-screen section mounts only pins', () => {
    const below = { ...input({ count: 50, scrollTop: 0, overscan: 8 }), sectionTop: 5000 };
    const r = computeSectionWindow(below);
    expect(mounted(r)).toBe(0);
    expect(r.padTop + r.padBottom).toBe(r.totalHeight);
    const pinned = computeSectionWindow({ ...below, pins: [3] });
    expect([pinned.startIndex, pinned.endIndex]).toEqual([3, 3]);
    expect(pinned.padTop).toBe(75);
    expect(pinned.padBottom).toBe(46 * 25);
    const above = computeSectionWindow({
      ...input({ count: 50, scrollTop: 9000, overscan: 8 }),
      sectionTop: 0,
    });
    expect(mounted(above)).toBe(0);
    expect(above.padTop + above.padBottom).toBe(above.totalHeight);
  });

  it('10 sections × 500 rows, viewport 600, rowHeight 25, overscan 8: Σ mounted ≤ 24 + 2·8·2 + pins', () => {
    const sectionHeight = 500 * 25;
    for (const scrollTop of [0, 6000, 12400, 12500, 30000, 12500 * 9 - 600]) {
      let total = 0;
      let windows = 0;
      for (let i = 0; i < 10; i++) {
        const r = computeSectionWindow({
          count: 500,
          scrollTop,
          viewportHeight: 600,
          rowHeight: 25,
          overscan: 8,
          sectionTop: i * sectionHeight,
        });
        total += mounted(r);
        if (mounted(r) > 0) windows++;
      }
      expect(windows).toBeLessThanOrEqual(2);
      expect(total).toBeLessThanOrEqual(24 + 2 * 8 * 2);
    }
  });
});

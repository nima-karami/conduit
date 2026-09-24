import { describe, expect, it } from 'vitest';
import {
  computeReviewAnchor,
  computeWindow,
  estimateCardHeight,
  fileAtOrAfter,
  planRowCap,
  REVIEW_GROUP_HEAD_H,
  resolveReviewAnchor,
  reviewListItems,
  type WindowInput,
} from '../../webview/review-window';

/** Build a WindowInput with sane defaults; override what a case cares about. */
const input = (over: Partial<WindowInput> = {}): WindowInput => ({
  count: 0,
  scrollTop: 0,
  viewportHeight: 500,
  overscanPx: 0,
  estimate: () => 100,
  measured: new Map(),
  ...over,
});

/** Reference offset table from the same height rule computeWindow uses. */
const heights = (i: WindowInput): number[] => {
  const out: number[] = [];
  for (let k = 0; k < i.count; k++) out.push(i.measured.get(k) ?? i.estimate(k));
  return out;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('computeWindow', () => {
  it('count 0 → empty range, everything zero', () => {
    const r = computeWindow(input({ count: 0 }));
    expect(r).toEqual({ startIndex: 0, endIndex: -1, padTop: 0, padBottom: 0, totalHeight: 0 });
  });

  it('viewportHeight 0 → empty range, request nothing, but totalHeight reflects all', () => {
    const r = computeWindow(input({ count: 10, viewportHeight: 0 }));
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(-1);
    expect(r.totalHeight).toBe(1000);
  });

  it('one card → trivially the whole list', () => {
    const r = computeWindow(input({ count: 1, viewportHeight: 500 }));
    expect(r.startIndex).toBe(0);
    expect(r.endIndex).toBe(0);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe(0);
    expect(r.totalHeight).toBe(100);
  });

  it('top of a long list mounts only the leading cards (+overscan 0)', () => {
    const r = computeWindow(input({ count: 1000, viewportHeight: 500 }));
    expect(r.startIndex).toBe(0);
    // 500px viewport / 100px cards → cards 0..4 intersect; card 5 starts at 500 (== bottom, excluded).
    expect(r.endIndex).toBe(4);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe(1000 * 100 - 500);
    expect(r.totalHeight).toBe(100000);
  });

  it('overscan widens the range symmetrically and clamps at the top edge', () => {
    const top = computeWindow(input({ count: 1000, viewportHeight: 500, overscanPx: 200 }));
    expect(top.startIndex).toBe(0); // clamped — can't go below 0
    expect(top.endIndex).toBe(6); // 700px / 100 → 0..6
  });

  it('overscan clamps at the bottom edge', () => {
    const r = computeWindow(
      input({ count: 10, scrollTop: 600, viewportHeight: 500, overscanPx: 1000 }),
    );
    expect(r.endIndex).toBe(9); // clamped to last card
    expect(r.padBottom).toBe(0);
  });

  it('scrollTop beyond content → only the last card(s)', () => {
    const r = computeWindow(input({ count: 10, scrollTop: 99999, viewportHeight: 500 }));
    expect(r.startIndex).toBe(9);
    expect(r.endIndex).toBe(9);
    expect(r.padBottom).toBe(0);
    expect(r.padTop).toBe(900);
  });

  it('mixed measured + estimated heights place the window correctly', () => {
    const measured = new Map<number, number>([
      [0, 300],
      [1, 50],
    ]);
    // offsets: c0=[0,300) c1=[300,350) c2=[350,450) c3=[450,550) ...
    const r = computeWindow(input({ count: 20, scrollTop: 320, viewportHeight: 100, measured }));
    // window [320,420): c1 bottom 350>320 → start 1; c3 top 450>=420 excluded → end 2.
    expect(r.startIndex).toBe(1);
    expect(r.endIndex).toBe(2);
    expect(r.padTop).toBe(300);
  });

  it('spacer invariant + bounds hold across randomized inputs', () => {
    let seed = 1234567;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 500; t++) {
      const count = Math.floor(rnd() * 60);
      const measured = new Map<number, number>();
      for (let k = 0; k < count; k++) {
        if (rnd() < 0.5) measured.set(k, 10 + Math.floor(rnd() * 400));
      }
      const i = input({
        count,
        scrollTop: Math.floor(rnd() * 8000) - 500,
        viewportHeight: Math.floor(rnd() * 900),
        overscanPx: Math.floor(rnd() * 300),
        estimate: (idx) => 20 + ((idx * 37) % 250),
        measured,
      });
      const r = computeWindow(i);
      const hs = heights(i);
      const total = sum(hs);

      expect(r.totalHeight).toBe(total);
      // bounds
      expect(r.startIndex).toBeGreaterThanOrEqual(0);
      expect(r.endIndex + 1).toBeLessThanOrEqual(count);
      expect(r.startIndex).toBeLessThanOrEqual(r.endIndex + 1);

      if (r.endIndex < r.startIndex) {
        // empty window (count 0 or viewport 0)
        expect(r.padTop).toBe(0);
        expect(r.padBottom).toBe(0);
      } else {
        const visible = sum(hs.slice(r.startIndex, r.endIndex + 1));
        expect(r.padTop + visible + r.padBottom).toBe(total);
        expect(r.padTop).toBe(sum(hs.slice(0, r.startIndex)));
        expect(r.padBottom).toBe(sum(hs.slice(r.endIndex + 1)));
      }
    }
  });

  it('monotonicity: increasing scrollTop never decreases startIndex', () => {
    const measured = new Map<number, number>();
    for (let k = 0; k < 200; k++) measured.set(k, 30 + ((k * 13) % 200));
    let prev = -1;
    for (let s = 0; s <= 20000; s += 53) {
      const r = computeWindow(
        input({ count: 200, scrollTop: s, viewportHeight: 400, overscanPx: 120, measured }),
      );
      expect(r.startIndex).toBeGreaterThanOrEqual(prev);
      prev = r.startIndex;
    }
  });

  it('computeWindow with mixed estimate heights offsets section rows correctly', () => {
    // The review navigator's list is one section header (28px) followed by ten file rows (44px):
    // offsets 0, 28, 72, 116, 160, 204, 248, 292, 336, 380, 424; total 28 + 10*44 = 468.
    const NAV_SECTION_H = 28;
    const NAV_ROW_H = 44;
    const mixed = input({
      count: 11,
      // Past the header and two rows: 28 + 44 + 44.
      scrollTop: NAV_SECTION_H + 2 * NAV_ROW_H,
      viewportHeight: 100,
      overscanPx: 0,
      estimate: (i) => (i === 0 ? NAV_SECTION_H : NAV_ROW_H),
    });
    const r = computeWindow(mixed);
    // Row 2's bottom edge is exactly the window top, so row 3 is the first mounted item and the
    // spacer above it must carry the section's 28px, not a third row's 44.
    expect(r.startIndex).toBe(3);
    expect(r.padTop).toBe(116);
    expect(r.endIndex).toBe(5);
    expect(r.padBottom).toBe(220);
    expect(r.totalHeight).toBe(468);
  });
});

describe('estimateCardHeight', () => {
  it('grows with row count', () => {
    expect(estimateCardHeight(100, 100)).toBeGreaterThan(estimateCardHeight(1, 1));
  });
  it('clamps to a sane minimum for tiny changes', () => {
    const a = estimateCardHeight(0, 0);
    const b = estimateCardHeight(1, 0);
    expect(a).toBe(b); // both pinned to the floor
    expect(a).toBeGreaterThan(0);
  });
  it('clamps to a sane maximum for pathological changes', () => {
    expect(estimateCardHeight(1_000_000, 1_000_000)).toBe(estimateCardHeight(50_000, 50_000));
  });
});

describe('planRowCap', () => {
  it('renders everything when under the cap', () => {
    expect(planRowCap([10, 20], 100, false)).toEqual({ shown: [10, 20], remaining: 0 });
  });
  it('renders everything when expanded, even over the cap', () => {
    expect(planRowCap([2000, 2000], 100, true)).toEqual({ shown: [2000, 2000], remaining: 0 });
  });
  it('caps across hunks and reports the remainder', () => {
    const r = planRowCap([60, 60, 60], 100, false);
    expect(r.shown).toEqual([60, 40, 0]);
    expect(r.remaining).toBe(80);
    expect(r.shown.reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('exact-fit at the cap leaves no remainder', () => {
    expect(planRowCap([50, 50], 100, false)).toEqual({ shown: [50, 50], remaining: 0 });
  });

  // The "new 1000-line file" complaint: a pure-add file is one all-add hunk → lineCounts === [N].
  // At the lowered cap (300) it must portion, not render the whole file (spec 2026-06-29-review-card-collapse §3.2).
  it('portions a 1000-line pure-add file at the 300 cap', () => {
    expect(planRowCap([1000], 300, false)).toEqual({ shown: [300], remaining: 700 });
  });
  it('"Show all" (expanded) reveals every row of the pure-add file', () => {
    expect(planRowCap([1000], 300, true)).toEqual({ shown: [1000], remaining: 0 });
  });
});

describe('review scroll anchor', () => {
  const paths = ['a', 'b', 'c', 'd'];
  const h = () => 100; // uniform 100px cards: offsets a=0 b=100 c=200 d=300
  const pathOf = (i: number) => paths[i];
  const indexOfPath = (p: string) => {
    const i = paths.indexOf(p);
    return i === -1 ? undefined : i;
  };

  it('returns null for an empty list', () => {
    expect(computeReviewAnchor(0, 0, h, pathOf)).toBeNull();
  });

  it('anchors to the top-visible card + intra-card offset', () => {
    // scrollTop 250 → card c (offset 200..300), 50px into it.
    expect(computeReviewAnchor(250, 4, h, pathOf)).toEqual({ topPath: 'c', offset: 50 });
  });

  it('top of list → first card, zero offset', () => {
    expect(computeReviewAnchor(0, 4, h, pathOf)).toEqual({ topPath: 'a', offset: 0 });
  });

  it('round-trips compute → resolve at the same heights', () => {
    const a = computeReviewAnchor(250, 4, h, pathOf);
    expect(a).not.toBeNull();
    if (a) expect(resolveReviewAnchor(a, 4, h, indexOfPath)).toBe(250);
  });

  it('resolves to the same card even when heights changed (offset preserved)', () => {
    // Card b is now 60px tall above it (a=0..60), so b starts at 60; anchor {b, 20} → 80.
    const variable = (i: number) => (i === 0 ? 60 : 100);
    expect(resolveReviewAnchor({ topPath: 'b', offset: 20 }, 4, variable, indexOfPath)).toBe(80);
  });

  it('falls back to top when the anchored path is gone', () => {
    expect(resolveReviewAnchor({ topPath: 'zzz', offset: 40 }, 4, h, indexOfPath)).toBe(0);
  });

  it('last card anchors even when scrolled past content end', () => {
    expect(computeReviewAnchor(99999, 4, h, pathOf)?.topPath).toBe('d');
  });
});

describe('reviewListItems', () => {
  it('null groups → identity itemOfFile', () => {
    const list = reviewListItems(null, 3);
    expect(list.items).toEqual([
      { kind: 'file', fileIndex: 0 },
      { kind: 'file', fileIndex: 1 },
      { kind: 'file', fileIndex: 2 },
    ]);
    expect(list.itemOfFile).toEqual([0, 1, 2]);
  });

  it('[2,3] → items G,F0,F1,G,F2,F3,F4 and itemOfFile [1,2,4,5,6]', () => {
    const list = reviewListItems([2, 3], 5);
    expect(list.items).toEqual([
      { kind: 'group', groupIndex: 0 },
      { kind: 'file', fileIndex: 0 },
      { kind: 'file', fileIndex: 1 },
      { kind: 'group', groupIndex: 1 },
      { kind: 'file', fileIndex: 2 },
      { kind: 'file', fileIndex: 3 },
      { kind: 'file', fileIndex: 4 },
    ]);
    expect(list.itemOfFile).toEqual([1, 2, 4, 5, 6]);
  });

  it('fileAtOrAfter(group item) → its first file; past end → -1', () => {
    const list = reviewListItems([2, 3], 5);
    expect(fileAtOrAfter(list, 0)).toBe(0);
    expect(fileAtOrAfter(list, 2)).toBe(1);
    expect(fileAtOrAfter(list, 3)).toBe(2);
    expect(fileAtOrAfter(list, 6)).toBe(4);
    expect(fileAtOrAfter(list, 7)).toBe(-1);
    expect(fileAtOrAfter(reviewListItems([2, 0], 2), 3)).toBe(-1);
  });

  it('computeWindow over items with a fixed group height keeps padTop + mounted + padBottom = totalHeight', () => {
    const list = reviewListItems([2, 3, 1], 6);
    const h = (i: number) => (list.items[i].kind === 'group' ? REVIEW_GROUP_HEAD_H : 100);
    const hs = list.items.map((_, i) => h(i));
    const total = sum(hs);
    expect(total).toBe(3 * REVIEW_GROUP_HEAD_H + 6 * 100);
    for (let s = 0; s <= total + 200; s += 17) {
      const r = computeWindow(
        input({ count: list.items.length, scrollTop: s, viewportHeight: 150, estimate: h }),
      );
      const mounted = sum(hs.slice(r.startIndex, r.endIndex + 1));
      expect(r.totalHeight).toBe(total);
      expect(r.padTop + mounted + r.padBottom).toBe(total);
      expect(r.padTop).toBe(sum(hs.slice(0, r.startIndex)));
    }
  });
});

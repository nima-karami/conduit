import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Review list's anchor restore has to land BEFORE the first paint, or the list paints at the
 * top and then jumps to where the user was — the same failure shape as CLAUDE.md's "zoomable
 * surfaces must apply their fit before first paint".
 *
 * That guarantee rests on TWO effects, not one. The restore bails while `viewportHeight` is 0
 * (until the viewport is measured the windower mounts no cards and renders no spacers, so the
 * scroller has no height and any offset written clamps to 0), so what actually restores is the
 * re-render that measuring triggers. Only a LAYOUT effect forces that re-render synchronously,
 * before the browser paints — demote the viewport measurement to `useEffect` and the restore
 * silently moves after the paint while every behavioural test stays green, because the final
 * offset is identical. Both halves are asserted here for that reason.
 *
 * A smoke test cannot cover this: the only difference is one painted frame, and the e2e suite
 * runs the window hidden, where rAF is throttled to roughly 1fps. Reading the source is what is
 * left (same reasoning as `drag-region.test.ts`).
 */

const SRC = readFileSync(
  join(__dirname, '..', '..', 'webview', 'components', 'review-view.tsx'),
  'utf8',
);

/** ReviewView's own body — `ReviewFileNav` further down has its own viewport/measure pair. */
const VIEW = (() => {
  const from = SRC.indexOf('export function ReviewView(');
  const to = SRC.indexOf('function ReviewKeyHelp(');
  expect(from, 'ReviewView moved — update this guard').toBeGreaterThan(0);
  expect(to, 'ReviewKeyHelp moved — update this guard').toBeGreaterThan(from);
  return SRC.slice(from, to);
})();

/** Offset of a marker that must appear exactly once in ReviewView. */
function only(marker: string): number {
  const at = VIEW.indexOf(marker);
  expect(at, `\`${marker}\` is gone — update this guard`).toBeGreaterThan(0);
  expect(VIEW.indexOf(marker, at + 1), `\`${marker}\` is no longer unique`).toBe(-1);
  return at;
}

/**
 * Which hook opens the effect containing `at` — the nearest preceding effect opener. Matched on
 * the full call token, not a bare `use`, so prose inside the body ("because", "used") can't be
 * mistaken for the declaration.
 */
function effectKindAt(at: number): string {
  const layout = VIEW.lastIndexOf('useLayoutEffect(', at);
  const passive = VIEW.lastIndexOf('useEffect(', at);
  expect(Math.max(layout, passive), 'no effect encloses this code').toBeGreaterThan(0);
  return layout > passive ? 'useLayoutEffect' : 'useEffect';
}

describe('review anchor restore runs pre-paint', () => {
  it('restores in a layout effect', () => {
    expect(effectKindAt(only('if (scrollRestoredRef.current) return;'))).toBe('useLayoutEffect');
  });

  it('measures the viewport in a layout effect too — the restore rides its re-render', () => {
    expect(effectKindAt(only('setViewportHeight(el.clientHeight);'))).toBe('useLayoutEffect');
  });

  it('bails out — not merely branches — while the viewport is unmeasured', () => {
    const at = only('if (scrollRestoredRef.current) return;');
    // Anything short of an early `return` leaves the restore writing an offset the scroller has
    // no height to accept, which clamps it straight back to 0.
    expect(VIEW.slice(at, at + 600)).toMatch(/viewportHeight === 0\)\s*return;/);
  });
});

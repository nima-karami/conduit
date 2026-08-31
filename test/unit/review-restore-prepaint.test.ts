import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Review list's anchor restore has to run in a LAYOUT effect. In a passive one it lands a
 * frame late: the list paints at the top and then jumps to where the user was — the same failure
 * shape as CLAUDE.md's "zoomable surfaces must apply their fit before first paint".
 *
 * A smoke test cannot guard this. The final scroll offset is identical either way, so the only
 * difference is one painted frame — and the e2e suite runs the window hidden, where rAF is
 * throttled to roughly 1fps and no probe can sample that frame. Reading the source is what is
 * left (same reasoning as `drag-region.test.ts`).
 */

const SRC = readFileSync(
  join(__dirname, '..', '..', 'webview', 'components', 'review-view.tsx'),
  'utf8',
);

/** The effect body that restores the saved anchor, identified by the one-shot guard it opens with. */
function restoreEffect(): string {
  const at = SRC.indexOf('if (scrollRestoredRef.current) return;');
  expect(at, 'the anchor-restore effect moved — update this guard').toBeGreaterThan(0);
  const open = SRC.lastIndexOf('use', at);
  return SRC.slice(open, at);
}

describe('review anchor restore', () => {
  it('runs pre-paint, in a layout effect', () => {
    expect(restoreEffect()).toContain('useLayoutEffect');
  });

  it('waits for the measured viewport, without which the list has no scrollable height', () => {
    // computeWindow mounts nothing and renders no spacers while viewportHeight is 0, so an offset
    // written before it is measured clamps straight back to 0.
    const at = SRC.indexOf('if (scrollRestoredRef.current) return;');
    const body = SRC.slice(at, at + 600);
    expect(body).toContain('viewportHeight === 0');
  });
});

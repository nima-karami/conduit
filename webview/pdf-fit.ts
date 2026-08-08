/** Page geometry for the PDF viewer's fit modes — pure, so the math is testable without a
 *  document. See the viewer-robustness spec §3 Lane PD4. */

export interface PageSize {
  width: number;
  height: number;
}

export type FitMode = 'none' | 'width' | 'page';

// pdf.js's own viewer floor. A coarser one (0.25) cannot fit a 5000 pt page into a normal
// pane, so fit-width left it overflowing.
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
/** Room the page list's margins take out of the scroll container on both axes. */
export const PAGE_MARGIN = 48;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * The scale at which the whole document satisfies `mode` inside `container`, or null when
 * no meaningful fit exists (no pages, zero-size pages, unmeasured container) — the caller
 * then leaves the current scale alone.
 *
 * `rotation` is the viewer's whole-document rotation in degrees; on-screen bounds swap at
 * 90°/270°.
 */
export function fitScaleForPages(
  pages: readonly PageSize[],
  container: PageSize,
  mode: Exclude<FitMode, 'none'>,
  rotation = 0,
): number | null {
  // A fit must clear the *largest* page, not page 1: a mixed-size document scaled off its
  // first page leaves every wider page overflowing.
  const swap = rotation % 180 !== 0;
  let w = 0;
  let h = 0;
  for (const p of pages) {
    w = Math.max(w, swap ? p.height : p.width);
    h = Math.max(h, swap ? p.width : p.height);
  }
  if (!(w > 0) || !(h > 0)) return null;

  const availW = container.width - PAGE_MARGIN;
  if (!(availW > 0)) return null;
  if (mode === 'width') return clampScale(availW / w);

  const availH = container.height - PAGE_MARGIN;
  if (!(availH > 0)) return null;
  return clampScale(Math.min(availW / w, availH / h));
}

// Pure zoom/pan math for the image viewer, kept out of the component so the clamp
// and zoom-toward-pointer geometry are unit-testable (mirrors font-zoom.ts).

export const MAX_ZOOM = 8;
// Wheel = fine (10%), buttons = coarse (25%). Both multiplicative so each step is a
// constant ratio regardless of the current zoom (perceptually even).
export const WHEEL_STEP = 0.1;
export const BUTTON_STEP = 0.25;
/** Longest edge a rendered content box may take — the browser's own surface limit. */
export const MAX_RENDERED_EDGE = 16384;

/** Upscaling the fit is the vector overlay's business, not the raster viewer's; see
 *  spec §3 A6. Off by default so an upscaled raster never misrepresents the file. */
export interface ZoomOptions {
  allowUpscale?: boolean;
}

/** Zoom ceiling. Absolute `MAX_ZOOM` for raster; fit-relative when the fit itself
 *  upscales, so a diagram opened at 5× still has 8 doublings of headroom above it
 *  instead of clamping two button-steps in (spec §3 A6). */
function ceiling(fit: number, opts: ZoomOptions): number {
  return opts.allowUpscale ? Math.max(MAX_ZOOM, fit * MAX_ZOOM) : MAX_ZOOM;
}

/** Clamp a zoom factor to `[fit, ceiling]`. `fit` is the scale at which the image
 *  exactly fills the pane (≤ 1 when the image is larger than the pane). The viewer
 *  never zooms out past fit — there is nothing to pan when the whole image is shown. */
export function clampZoom(zoom: number, fit: number, opts: ZoomOptions = {}): number {
  const hi = ceiling(fit, opts);
  const lo = Math.min(fit, hi);
  return Math.min(hi, Math.max(lo, zoom));
}

/** Next zoom for a multiplicative step. `dir` is +1 (in) / -1 (out); `step` is the
 *  ratio (0.1 wheel / 0.25 button). Clamped to `[fit, ceiling]`. */
export function stepZoom(
  zoom: number,
  dir: 1 | -1,
  step: number,
  fit: number,
  opts: ZoomOptions = {},
): number {
  const next = dir > 0 ? zoom * (1 + step) : zoom / (1 + step);
  return clampZoom(next, fit, opts);
}

/** Largest scale at which `natural` still renders inside the browser's surface limit.
 *  One scale for both axes, so clamping never distorts the aspect ratio (spec §3 B5). */
export function maxScaleForEdge(
  natural: { w: number; h: number },
  maxEdge = MAX_RENDERED_EDGE,
): number {
  const longest = Math.max(natural.w, natural.h);
  return longest > 0 ? maxEdge / longest : Number.POSITIVE_INFINITY;
}

export interface Pan {
  x: number;
  y: number;
}

/**
 * Maximum pan offset (in CSS px, from centered) for an image of `natural` size shown
 * in a `pane` at scale `zoom`. The image is centered; pan can move it by at most half
 * the overflow in each axis. When the scaled image fits an axis, that axis can't pan (0).
 */
export function panBounds(
  natural: { w: number; h: number },
  pane: { w: number; h: number },
  zoom: number,
): { x: number; y: number } {
  const scaledW = natural.w * zoom;
  const scaledH = natural.h * zoom;
  return {
    x: Math.max(0, (scaledW - pane.w) / 2),
    y: Math.max(0, (scaledH - pane.h) / 2),
  };
}

/** Clamp a pan offset to its bounds so the image can never be dragged off the pane. */
export function clampPan(
  pan: Pan,
  natural: { w: number; h: number },
  pane: { w: number; h: number },
  zoom: number,
): Pan {
  const b = panBounds(natural, pane, zoom);
  return {
    x: Math.min(b.x, Math.max(-b.x, pan.x)),
    y: Math.min(b.y, Math.max(-b.y, pan.y)),
  };
}

/**
 * Zoom toward a pointer: returns the new pan that keeps the image point currently
 * under the cursor stationary while the scale goes from `oldZoom` to `newZoom`.
 *
 * `pointer` is in pane coordinates with the pane CENTER as origin (so the pane center
 * is {0,0}). With a centered, translated image the content point under the cursor is
 * `(pointer - pan) / oldZoom`; to keep it fixed the new pan must satisfy
 * `pointer = content*newZoom + newPan`, i.e. `newPan = pointer - (pointer - pan) * (newZoom/oldZoom)`.
 */
export function panToKeepPointer(
  pan: Pan,
  pointer: { x: number; y: number },
  oldZoom: number,
  newZoom: number,
): Pan {
  const ratio = newZoom / oldZoom;
  return {
    x: pointer.x - (pointer.x - pan.x) * ratio,
    y: pointer.y - (pointer.y - pan.y) * ratio,
  };
}

/** Whether panning is possible at the current zoom (image overflows the pane on some axis). */
export function canPan(
  natural: { w: number; h: number },
  pane: { w: number; h: number },
  zoom: number,
): boolean {
  const b = panBounds(natural, pane, zoom);
  return b.x > 0.5 || b.y > 0.5;
}

/** The pane-fit scale: the largest scale at which the content fits entirely. Capped at
 *  1× unless `allowUpscale` — a raster upscaled by "fit" would misrepresent the file,
 *  while a vector diagram in a full-screen modal should fill it (spec §3 A6). */
export function fitScale(
  natural: { w: number; h: number },
  pane: { w: number; h: number },
  opts: ZoomOptions = {},
): number {
  if (natural.w <= 0 || natural.h <= 0 || pane.w <= 0 || pane.h <= 0) return 1;
  const contain = Math.min(pane.w / natural.w, pane.h / natural.h);
  return opts.allowUpscale ? contain : Math.min(1, contain);
}

/** Footer/announcement zoom string: a whole-number percentage of natural size. */
export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

// Pure sizing math for an INLINE mermaid diagram, kept out of the component so the
// fit/floor/cap geometry is unit-testable (mirrors image-zoom.ts / svg-viewbox.ts).

/** Legibility floor: below this a diagram is a smear, so it scrolls instead (spec §6.1). */
export const MIN_INLINE_SCALE = 0.35;
/** Share of the viewport an inline diagram may occupy before it is scaled down (spec §6.2). */
export const INLINE_MAX_HEIGHT_FRACTION = 0.7;

/** Sub-pixel slack, so a rounding remainder never invents a scrollbar. */
const EPSILON = 0.5;

export interface InlineScaleInput {
  natural: { w: number; h: number };
  columnWidth: number;
  maxHeight: number;
  minScale: number;
}

export interface InlineScaleResult {
  scale: number;
  width: number;
  height: number;
  /** The rendered box exceeds the column or the cap, so the wrapper must scroll. */
  scrolls: boolean;
  /** The height cap is what bound the scale — the diagram is smaller than the column allows. */
  capped: boolean;
}

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * Rendered size for a diagram of `natural` size in a `columnWidth` column.
 *
 * Scales down to fit the column and `maxHeight`, never below `minScale` and never above 1
 * — inline never upscales; the zoom overlay is where a small diagram fills the screen
 * (spec §3 C1/C2). Past the floor the box outgrows its wrapper and `scrolls` says so.
 */
export function inlineDiagramScale({
  natural,
  columnWidth,
  maxHeight,
  minScale,
}: InlineScaleInput): InlineScaleResult {
  if (!positive(natural.w) || !positive(natural.h)) {
    return { scale: 1, width: 0, height: 0, scrolls: false, capped: false };
  }

  const fitWidth = positive(columnWidth) ? columnWidth / natural.w : Number.POSITIVE_INFINITY;
  const fitHeight = positive(maxHeight) ? maxHeight / natural.h : Number.POSITIVE_INFINITY;
  const floor = Math.min(1, Math.max(0, minScale));
  const scale = Math.max(floor, Math.min(1, fitWidth, fitHeight));

  const width = natural.w * scale;
  const height = natural.h * scale;
  return {
    scale,
    width,
    height,
    scrolls:
      (positive(columnWidth) && width > columnWidth + EPSILON) ||
      (positive(maxHeight) && height > maxHeight + EPSILON),
    capped: scale < 1 && positive(maxHeight) && height >= maxHeight - EPSILON,
  };
}

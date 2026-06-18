// Pure parse of an SVG `viewBox` into intrinsic width/height, kept out of the
// component so the geometry is unit-testable (mirrors image-zoom.ts / font-zoom.ts).

export interface Size {
  w: number;
  h: number;
}

/**
 * Intrinsic size from a `viewBox` value (`min-x min-y width height`). Returns
 * `{ w: 0, h: 0 }` when the value is absent or malformed so callers fall back to a
 * measured rect rather than dividing by a bogus number.
 */
export function svgViewBoxSize(viewBox: string | null | undefined): Size {
  if (!viewBox) return { w: 0, h: 0 };
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { w: 0, h: 0 };
  const [, , w, h] = parts;
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  return { w, h };
}

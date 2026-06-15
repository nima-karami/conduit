// Per-surface font zoom (terminal + editor). The interface font-size setting
// (--font-scale) scales UI chrome; this is the separate Ctrl/Cmd +/-/0 zoom of the
// terminal (xterm) and code editor (Monaco) CONTENT, sized in JS rather than CSS.

export const MIN_SURFACE_FONT = 8;
export const MAX_SURFACE_FONT = 32;
export const DEFAULT_SURFACE_FONT = 13;

/** Clamp a surface font size to the supported range and round to an integer. */
export const clampSurfaceFont = (n: number): number =>
  Math.min(MAX_SURFACE_FONT, Math.max(MIN_SURFACE_FONT, Math.round(n)));

interface ZoomKey {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  key: string;
}

/**
 * Resolve a Ctrl/Cmd +/-/0 zoom gesture to the next surface font size, or null when
 * the event is not a zoom gesture. `+`/`=` grow, `-`/`_` shrink (one step each),
 * `0` resets to the default. Alt is excluded so it never collides with other combos.
 */
export function fontZoomTarget(current: number, e: ZoomKey): number | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;
  if (e.key === '+' || e.key === '=') return clampSurfaceFont(current + 1);
  if (e.key === '-' || e.key === '_') return clampSurfaceFont(current - 1);
  if (e.key === '0') return DEFAULT_SURFACE_FONT;
  return null;
}

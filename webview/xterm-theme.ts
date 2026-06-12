import type { ITheme } from '@xterm/xterm';
import { MONO_FONTS } from './themes';

const v = (cs: CSSStyleDeclaration, name: string, fallback: string): string => {
  const got = cs.getPropertyValue(name).trim();
  return got || fallback;
};

/** "#rrggbb" + alpha → "rgba(...)". Returns the input unchanged if not a hex colour. */
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || a >= 1) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Pure mapping from the shared surface colour + opacity to the xterm
 * `theme.background` value: the same colour the code block uses, with the
 * code-block opacity applied (R4.3b — editor and terminal share one configurable
 * translucent surface). Extracted so the colour→background mapping is
 * unit-testable without a DOM.
 *
 * NOTE: `buildXtermTheme` no longer paints the canvas with this colour — it makes
 * the canvas fully transparent and lets the translucent `.termwrap` container
 * (styled with `--term-surface` = this same colour×opacity) provide the single
 * surface, so the two translucent layers don't stack and double-darken. This
 * helper is kept as the documented/tested derivation of what that single surface
 * resolves to (and what the container's `--term-surface` produces).
 */
export function terminalBackground(surfaceColor: string, alpha: number): string {
  return withAlpha(surfaceColor, alpha);
}

/** Build an xterm theme from the active CSS theme variables on <html>.
 *
 *  The terminal background is the SAME configurable surface as the code block
 *  (R4.3b): the shared colour (`--term-bg` = settings.surfaceColor) at the
 *  code-block opacity (`--code-alpha` = codeOpacity). Rather than paint the xterm
 *  canvas with that translucent colour (which would stack on top of the equally
 *  translucent `.termwrap` container and darken the terminal vs. the editor), the
 *  canvas is made **fully transparent** (`'rgba(0,0,0,0)'`, requires
 *  `allowTransparency` on the Terminal) so the single translucent container
 *  surface shows through — exactly matching the code block's one `--code-surface`
 *  layer and letting the animated backdrop show by the same amount. Text/glyphs
 *  stay crisp because xterm draws them over the transparent cell background.
 *
 *  `surfaceColor` is accepted for symmetry with the live re-apply path (and is
 *  reflected by the container's `--term-bg`); the canvas itself stays transparent
 *  regardless, so the colour/opacity live entirely in `--term-surface`. */
export function buildXtermTheme(_surfaceColor?: string): ITheme {
  const cs = getComputedStyle(document.documentElement);
  return {
    // Transparent canvas — the translucent `.termwrap` container (`--term-surface`)
    // is the one surface; see the doc comment above.
    background: 'rgba(0,0,0,0)',
    foreground: v(cs, '--text', '#d7dae1'),
    cursor: v(cs, '--accent', '#d9775c'),
    cursorAccent: v(cs, '--bg', '#0a0b0e'),
    selectionBackground: v(cs, '--accent-soft', 'rgba(217,119,92,0.3)'),
    black: v(cs, '--raise', '#15171c'),
    red: v(cs, '--red', '#e0726f'),
    green: v(cs, '--green', '#6cc18a'),
    yellow: v(cs, '--amber', '#d9a14b'),
    blue: v(cs, '--blue', '#5e9bd6'),
    magenta: v(cs, '--accent', '#d9775c'),
    cyan: '#67c1c0',
    white: v(cs, '--text-dim', '#d7dae1'),
    brightBlack: v(cs, '--text-faint', '#585e6a'),
    brightWhite: v(cs, '--text', '#ffffff'),
  };
}

/** Resolve a mono-font CSS stack from a settings font id. */
export function monoStack(id: string): string {
  return MONO_FONTS.find((f) => f.id === id)?.stack ?? "'JetBrains Mono', ui-monospace, monospace";
}

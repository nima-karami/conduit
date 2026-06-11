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
 * Pure mapping from the shared surface colour (wishlist I1) to the xterm
 * `theme.background` value: the same colour the code block uses, with the
 * terminal's surface opacity applied (the code-block opacity is intentionally
 * NOT used here — terminals stay legible at the panel opacity). Extracted so the
 * colour→background mapping is unit-testable without a DOM.
 */
export function terminalBackground(surfaceColor: string, alpha: number): string {
  return withAlpha(surfaceColor, alpha);
}

/** Build an xterm theme from the active CSS theme variables on <html>. The
 *  terminal background colour is the shared surface colour (`--term-bg`,
 *  wishlist I1) so it matches the code block; it follows the app's surface
 *  opacity so the animated backdrop shows through it (requires
 *  allowTransparency on the Terminal).
 *
 *  Pass `surfaceColor` for a live re-apply so the theme uses the new value
 *  directly and never lags a render behind the CSS var; without it the colour
 *  is read from the live `--term-bg` var (same pattern as monaco-theme.ts). */
export function buildXtermTheme(surfaceColor?: string): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const bgNone = document.documentElement.dataset.background === 'none';
  const alpha = bgNone ? 1 : Number(v(cs, '--surface-alpha', '1')) || 1;
  const termBg = surfaceColor ?? v(cs, '--term-bg', v(cs, '--bg', '#0a0b0e'));
  return {
    background: terminalBackground(termBg, alpha),
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

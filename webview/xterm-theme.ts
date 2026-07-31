import type { ITheme } from '@xterm/xterm';
import { cssVar } from './css-var';
import { MONO_FONTS } from './themes';

/** "#rrggbb" + alpha → "rgba(...)". Returns the input unchanged if not a hex colour. */
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || a >= 1) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Surface colour + opacity → the resolved translucent background value (R4.3b —
 * editor and terminal share one configurable surface). `buildXtermTheme` no longer
 * paints the canvas with this; it keeps the canvas transparent and lets the
 * `.termwrap` container (`--term-surface` = this value) be the single surface, so
 * the two translucent layers don't stack and double-darken. Kept as the
 * documented/tested derivation of what that surface resolves to.
 */
export function terminalBackground(surfaceColor: string, alpha: number): string {
  return withAlpha(surfaceColor, alpha);
}

/** Build an xterm theme from the active CSS theme variables on <html>.
 *
 *  The canvas is kept **fully transparent** (`'rgba(0,0,0,0)'`, requires
 *  `allowTransparency` on the Terminal) rather than painted with the translucent
 *  surface colour: painting it would stack on the equally translucent `.termwrap`
 *  container and darken the terminal vs. the editor (R4.3b). The container's
 *  `--term-surface` is the one surface. `surfaceColor` is accepted only for symmetry
 *  with the live re-apply path; the canvas stays transparent regardless. */
export function buildXtermTheme(_surfaceColor?: string): ITheme {
  const cs = getComputedStyle(document.documentElement);
  // The terminal is ink in ALL THREE themes, so its neutrals come from the on-ink code
  // tokens, not the page-level --text tiers: under Aero those are ink-on-white and would
  // be invisible here. Neon needs no branch of its own — its --code-cursor is the #00f0ff
  // the contract asks for.
  return {
    background: 'rgba(0,0,0,0)',
    foreground: cssVar(cs, '--syn-default', '#e7e9f0'),
    cursor: cssVar(cs, '--code-cursor', '#9db4f0'),
    cursorAccent: cssVar(cs, '--code-base', '#15161b'),
    selectionBackground: cssVar(cs, '--code-selection', 'rgba(157,180,240,0.16)'),
    black: cssVar(cs, '--code-base', '#15161b'),
    red: cssVar(cs, '--red', '#e0726f'),
    green: cssVar(cs, '--green', '#6cc18a'),
    yellow: cssVar(cs, '--amber', '#e5a94a'),
    blue: cssVar(cs, '--blue', '#7fa8e8'),
    magenta: cssVar(cs, '--syn-keyword', '#a56be8'),
    cyan: '#67c1c0',
    white: cssVar(cs, '--syn-default', '#e7e9f0'),
    brightBlack: cssVar(cs, '--code-line-number', '#6f748a'),
    brightWhite: '#ffffff',
  };
}

/** Resolve a mono-font CSS stack from a settings font id. */
export function monoStack(id: string): string {
  return MONO_FONTS.find((f) => f.id === id)?.stack ?? "'JetBrains Mono', ui-monospace, monospace";
}

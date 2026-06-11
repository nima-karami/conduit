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

/** Build an xterm theme from the active CSS theme variables on <html>. The
 *  terminal background follows the app's surface opacity so the animated
 *  backdrop shows through it (requires allowTransparency on the Terminal). */
export function buildXtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const bgNone = document.documentElement.dataset.background === 'none';
  const alpha = bgNone ? 1 : Number(v(cs, '--surface-alpha', '1')) || 1;
  return {
    background: withAlpha(v(cs, '--bg', '#0a0b0e'), alpha),
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

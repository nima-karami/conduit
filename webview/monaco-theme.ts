import * as monaco from 'monaco-editor';
import { cssVar } from './css-var';

/** "#rrggbb" + alpha → "#rrggbbaa". Monaco colours accept 8-digit hex; returns the
 *  input unchanged when alpha is opaque or the value isn't a 6-digit hex. */
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || a >= 1) return m ? `#${m[1]}` : hex;
  const aa = Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${m[1]}${aa}`;
}

/**
 * Register a theme matching the app palette. Re-defines on each call so the editor
 * background follows the user's code-block colour + opacity (wishlist C3); when
 * opacity < 1 the canvas paints translucent so the backdrop shows through.
 *
 * Pass `code` (settings values) for a live re-apply so the theme uses the new values
 * directly and never lags a render behind the CSS vars; without it they're read from
 * the live `--code-bg` / `--code-alpha` CSS vars (same pattern as xterm-theme.ts).
 */
export function ensureTheme(code?: { surfaceColor: string; codeOpacity: number }): string {
  let codeBg: string;
  let alpha: number;
  if (code) {
    codeBg = code.surfaceColor;
    alpha = code.codeOpacity;
  } else {
    const cs = getComputedStyle(document.documentElement);
    // Code-block surface colour + opacity (defaults reproduce the prior dark look).
    codeBg = cssVar(cs, '--code-bg', '#0a0b0e');
    const raw = Number(cssVar(cs, '--code-alpha', '1'));
    alpha = Number.isFinite(raw) ? raw : 1;
  }
  const bg = withAlpha(codeBg, alpha);
  monaco.editor.defineTheme('agentdeck', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '585e6a', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'd9775c' },
      { token: 'string', foreground: '6cc18a' },
      { token: 'number', foreground: 'd9a14b' },
      { token: 'type', foreground: '5e9bd6' },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': '#d7dae1',
      'editorLineNumber.foreground': '#3a3f49',
      'editor.selectionBackground': '#d9775c33',
      'editorCursor.foreground': '#d9775c',
      'editorGutter.background': bg,
      'diffEditor.insertedTextBackground': '#6cc18a22',
      'diffEditor.removedTextBackground': '#e0726f22',
    },
  });
  return 'agentdeck';
}

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

/** Monaco parses theme colours as hex only, but the contract states the washes
 *  (--code-selection, --diff-add, --diff-remove) as rgba(). Converts either form to
 *  hex; returns the fallback when the value is neither. */
function toHex(css: string, fallback: string): string {
  const v = css.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(v);
  if (!m) return fallback;
  const hex = (n: string) =>
    Math.round(Math.max(0, Math.min(255, Number(n))))
      .toString(16)
      .padStart(2, '0');
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const alpha = a >= 1 ? '' : hex(String(Math.round(a * 255)));
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}${alpha}`;
}

/**
 * Register a theme matching the app palette. Re-defines on each call, so a theme switch
 * needs no extra plumbing — the callers just re-run it — and the editor background follows
 * the user's code-block colour + opacity (wishlist C3); when opacity < 1 the canvas paints
 * translucent so the backdrop shows through.
 *
 * The token colours come from the live `--syn-*` / `--code-*` CSS vars (per-theme since the
 * revamp, see the token contract) rather than a second hardcoded palette here. All three
 * themes resolve to base `vs-dark`: the code panel is ink in light Aero too, so there is no
 * light Monaco variant.
 *
 * Pass `code` (settings values) for a live re-apply so the theme uses the new values
 * directly and never lags a render behind the CSS vars; without it they're read from
 * the live `--code-bg` / `--code-alpha` CSS vars (same pattern as xterm-theme.ts).
 */
export function ensureTheme(code?: { surfaceColor: string; codeOpacity: number }): string {
  const cs = getComputedStyle(document.documentElement);
  const base = cssVar(cs, '--code-base', '#15161b');
  let codeBg: string;
  let alpha: number;
  if (code) {
    codeBg = code.surfaceColor;
    alpha = code.codeOpacity;
  } else {
    codeBg = cssVar(cs, '--code-bg', base);
    const raw = Number(cssVar(cs, '--code-alpha', '1'));
    alpha = Number.isFinite(raw) ? raw : 1;
  }
  const bg = withAlpha(codeBg, alpha);
  // Rule foregrounds are hex WITHOUT the leading '#'.
  const syn = (name: string, fallback: string) =>
    toHex(cssVar(cs, name, fallback), fallback).replace('#', '');
  const col = (name: string, fallback: string) => toHex(cssVar(cs, name, fallback), fallback);
  monaco.editor.defineTheme('agentdeck', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: syn('--syn-comment', '#6f748a'), fontStyle: 'italic' },
      { token: 'keyword', foreground: syn('--syn-keyword', '#a56be8') },
      { token: 'string', foreground: syn('--syn-string', '#7fd6a4') },
      { token: 'number', foreground: syn('--syn-number', '#e0a86a') },
      { token: 'type', foreground: syn('--syn-type', '#9db4f0') },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': col('--syn-default', '#e7e9f0'),
      'editorLineNumber.foreground': col('--code-line-number', '#6f748a'),
      'editor.selectionBackground': col('--code-selection', '#9db4f029'),
      'editorCursor.foreground': col('--code-cursor', '#9db4f0'),
      'editorGutter.background': bg,
      'editor.lineHighlightBackground': col('--code-line-highlight', '#ffffff0a'),
      // Fully transparent: the frames wash the current-line row, and Monaco's default for
      // a rendered line highlight is the outline box we don't want.
      'editor.lineHighlightBorder': '#00000000',
      // The changed ROW carries the wash; without these Monaco falls back to its own green/red
      // and ignores the per-theme values entirely.
      'diffEditor.insertedLineBackground': col('--diff-add', '#7fd6a421'),
      'diffEditor.removedLineBackground': col('--diff-remove', '#c4483f26'),
      // Transparent, not the same token: Monaco paints the inner (character-range) wash ON TOP
      // of the line wash, so reusing it composited to ~28% and blew the contract's 9-15% ceiling.
      'diffEditor.insertedTextBackground': '#00000000',
      'diffEditor.removedTextBackground': '#00000000',
      // Peek Definition / Find All References render inside Monaco's own widgets. Without
      // these they fall back to stock vs-dark and read as a foreign panel dropped into the
      // app — most visibly on Paper. Mapped onto the app's surface/line/text tokens.
      // Deliberately the EDITOR-scoped tokens (--code-*) rather than the app's interaction
      // ones: --state-sel-bg and friends resolve to color-mix(), which computes to a form
      // toHex can't read, so every one of them would silently fall back.
      'editorWidget.background': col('--raise', '#1c1d24'),
      'editorWidget.foreground': col('--syn-default', '#e7e9f0'),
      'editorWidget.border': col('--border', '#2a2c36'),
      'peekViewTitle.background': col('--raise', '#1c1d24'),
      'peekViewTitleLabel.foreground': col('--syn-default', '#e7e9f0'),
      'peekViewTitleDescription.foreground': col('--code-line-number', '#6f748a'),
      'peekViewEditor.background': bg,
      'peekViewResult.background': col('--raise', '#1c1d24'),
      'peekViewResult.lineForeground': col('--syn-default', '#e7e9f0'),
      'peekViewResult.fileForeground': col('--code-line-number', '#6f748a'),
      'peekViewResult.selectionBackground': col('--code-selection', '#9db4f029'),
      'peekViewResult.selectionForeground': col('--syn-default', '#e7e9f0'),
      'peekViewResult.matchHighlightBackground': col('--code-selection', '#9db4f029'),
      'peekViewEditor.matchHighlightBackground': col('--code-selection', '#9db4f029'),
      'peekView.border': col('--code-cursor', '#9db4f0'),
      // The multi-result picker and the quick-open list are the same widget family.
      'list.hoverBackground': col('--code-line-highlight', '#ffffff0a'),
      'list.focusBackground': col('--code-selection', '#9db4f029'),
      'list.activeSelectionBackground': col('--code-selection', '#9db4f029'),
      'list.activeSelectionForeground': col('--syn-default', '#e7e9f0'),
      'list.inactiveSelectionBackground': col('--code-line-highlight', '#ffffff0a'),
    },
  });
  return 'agentdeck';
}

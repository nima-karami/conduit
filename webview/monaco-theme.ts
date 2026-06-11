import * as monaco from 'monaco-editor';

const v = (cs: CSSStyleDeclaration, name: string, fallback: string): string => {
  const got = cs.getPropertyValue(name).trim();
  return got || fallback;
};

/**
 * Register a theme matching the app palette. Idempotent per call but re-defines on
 * each invocation so the editor background follows the active theme's `--bg` (read
 * live from <html>, same pattern as xterm-theme.ts) instead of a hardcoded dark
 * value — keeping the code editor consistent with the Markdown/app surface.
 */
export function ensureTheme(): string {
  const cs = getComputedStyle(document.documentElement);
  // Opaque base colour of the active theme; matches the surface the Markdown viewer
  // renders on. (Translucency / opacity control is a separate item — wishlist C3.)
  const bg = v(cs, '--bg', '#0a0b0e');
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

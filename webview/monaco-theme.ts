import * as monaco from 'monaco-editor';

let defined = false;

/** Register a dark theme matching the app palette. Idempotent. */
export function ensureTheme(): string {
  if (!defined) {
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
        'editor.background': '#0a0b0e',
        'editor.foreground': '#d7dae1',
        'editorLineNumber.foreground': '#3a3f49',
        'editor.selectionBackground': '#d9775c33',
        'editorCursor.foreground': '#d9775c',
        'editorGutter.background': '#0a0b0e',
        'diffEditor.insertedTextBackground': '#6cc18a22',
        'diffEditor.removedTextBackground': '#e0726f22',
      },
    });
    defined = true;
  }
  return 'agentdeck';
}

/**
 * What a child process must not inherit from the app's env: editor identity (a CLI would think it
 * runs inside VS Code/Cursor), our own MCP wiring, and an editor's GIT_ASKPASS that would prompt in
 * the wrong window. Names are compared as given: a caller that folds case passes them upper-cased.
 * Node-free so the contracts can use it.
 */
export const isEditorKey = (key: string) => key.startsWith('VSCODE_') || key.startsWith('CURSOR_');

export function isChildEnvNoise(key: string, fromEditor: boolean): boolean {
  if (isEditorKey(key)) return true;
  if (key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') return true;
  if (key === 'CONDUIT_SESSION_TOKEN' || key === 'CONDUIT_MCP_ENDPOINT') return true;
  return key === 'GIT_ASKPASS' && fromEditor;
}

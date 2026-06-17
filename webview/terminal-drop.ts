// Drag-and-drop of files from the Files explorer onto a terminal, to insert a path
// reference at the prompt. The drag source (the file tree) tags the drag with this MIME
// so a terminal only reacts to explorer drags, not arbitrary text/HTML drops.

export const TERMINAL_PATH_MIME = 'application/x-conduit-path';

/**
 * Format an absolute path for insertion at a shell prompt: normalize to the OS-native
 * separator, wrap in double quotes when it contains whitespace, and add a trailing space
 * so the user can keep typing (or drop another file) right after. Pure + OS injected so
 * it is deterministic to test.
 */
export function formatPathForTerminal(path: string, isWindows: boolean): string {
  const normalized = isWindows ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/');
  const quoted = /\s/.test(normalized) ? `"${normalized}"` : normalized;
  return `${quoted} `;
}

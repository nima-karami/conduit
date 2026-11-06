// Drag-and-drop of files from the Files explorer onto a terminal, to insert a path
// reference at the prompt. The drag source (the file tree) tags the drag with this MIME
// so a terminal only reacts to explorer drags, not arbitrary text/HTML drops.

export const TERMINAL_PATH_MIME = 'application/x-conduit-path';

/**
 * Format an absolute path for a shell prompt: OS-native separator, double-quoted when it
 * contains whitespace, trailing space so the user can keep typing or drop another file.
 * OS is injected (not detected) so this is deterministic to test.
 */
export function formatPathForTerminal(path: string, isWindows: boolean): string {
  const normalized = isWindows ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/');
  const quoted = /\s/.test(normalized) ? `"${normalized}"` : normalized;
  return `${quoted} `;
}

/** The drop effect a terminal shows for a drag whose source allows `effectAllowed`: copy when
 *  the source allows it, else whatever it does allow — an effect outside it cancels the drop
 *  (a web tab's drag, say, is move-only). */
export function terminalDropEffect(effectAllowed: string): DataTransfer['dropEffect'] {
  if (effectAllowed === 'none') return 'none';
  if (effectAllowed === 'uninitialized' || effectAllowed === 'all') return 'copy';
  if (effectAllowed.startsWith('copy')) return 'copy';
  if (effectAllowed.startsWith('link')) return 'link';
  return 'move';
}

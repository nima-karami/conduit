// Decide the clipboard action for a key event in the terminal.
//
// Terminals are special: Ctrl+C is SIGINT, not Copy. We follow the Windows Terminal
// convention so copy/paste feel native without stealing the interrupt:
//   - Paste  → Ctrl/Cmd+V (or +Shift+V).
//   - Copy   → Ctrl/Cmd+Shift+C always; Cmd+C on macOS; and Ctrl+C WITH a selection
//              on Windows/Linux (no selection → returns null so the keystroke falls
//              through to xterm and reaches the shell as SIGINT).
// Returning null means "not a clipboard gesture — let the terminal handle it".

export type TermClipAction = 'copy' | 'paste';

interface Keyish {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

export function terminalClipboardAction(
  e: Keyish,
  hasSelection: boolean,
  isMac: boolean,
): TermClipAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'v') return 'paste';
  if (k === 'c') {
    if (e.shiftKey) return 'copy'; // Ctrl/Cmd+Shift+C — explicit copy, never SIGINT
    if (isMac) return e.metaKey ? 'copy' : null; // mac: Cmd+C copies, Ctrl+C = SIGINT
    return hasSelection ? 'copy' : null; // win/linux: copy when selecting, else SIGINT
  }
  return null;
}

// What Ctrl+V should do. On Linux, Claude Code reads an image from the clipboard itself when
// it receives a raw 0x16 on stdin, so an image-only clipboard forwards the keystroke. Off
// Linux that path is not taken, and a raw 0x16 is never sent without an image: in bash it is
// readline's quoted-insert and would swallow the next key.
export type PasteRoute = 'text' | 'raw-ctrl-v' | 'none';

export function pasteRoute(o: { text: string; hasImage: boolean; isLinux: boolean }): PasteRoute {
  if (o.text) return 'text';
  if (o.isLinux && o.hasImage) return 'raw-ctrl-v';
  return 'none';
}

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

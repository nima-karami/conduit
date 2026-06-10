// Central registry of keyboard shortcuts — the source of truth for the Settings
// "Shortcuts" tab and for matching key events. Display labels use ⌘ on mac.

export interface Shortcut {
  id: string;
  keys: string[]; // human-readable, e.g. ['Ctrl', 'P']
  description: string;
  group: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

export const SHORTCUTS: Shortcut[] = [
  { id: 'palette.files', keys: [MOD, 'P'], description: 'Search files in the active session', group: 'Navigation' },
  { id: 'palette.commands', keys: [MOD, 'Shift', 'P'], description: 'Command palette', group: 'Navigation' },
  { id: 'session.new', keys: [MOD, 'N'], description: 'New session', group: 'Sessions' },
  { id: 'session.close', keys: [MOD, 'W'], description: 'Close active tab / session', group: 'Sessions' },
  { id: 'settings.open', keys: [MOD, ','], description: 'Open settings', group: 'General' },
  { id: 'palette.dismiss', keys: ['Esc'], description: 'Close palette / modal', group: 'General' },
];

/** True if a keydown event matches Ctrl/Cmd + (optional Shift) + key. */
export function matchMod(e: KeyboardEvent, key: string, shift = false): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  return mod && e.shiftKey === shift && e.key.toLowerCase() === key.toLowerCase();
}

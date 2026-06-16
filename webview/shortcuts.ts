// Keybinding registry + matching. Combos use a `Mod` token that means Ctrl on
// Windows/Linux and ⌘ on macOS. Bindings are data-driven so they can be rebound
// in Settings and matched by a single handler in App.

export interface ShortcutAction {
  id: string;
  description: string;
  group: string;
  defaultCombo: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: 'openSearch',
    description: 'Search files & sessions',
    group: 'Navigation',
    defaultCombo: 'Mod+P',
  },
  {
    id: 'openCommands',
    description: 'Command palette',
    group: 'Navigation',
    defaultCombo: 'Mod+Shift+P',
  },
  {
    id: 'openBoard',
    description: 'Open feature board',
    group: 'Navigation',
    defaultCombo: 'Mod+Shift+B',
  },
  {
    id: 'openArchitecture',
    description: 'Open architecture canvas',
    group: 'Navigation',
    defaultCombo: 'Mod+Shift+A',
  },
  {
    id: 'openReview',
    description: 'Review all changes',
    group: 'Navigation',
    defaultCombo: 'Mod+Shift+R',
  },
  {
    id: 'openGlobalSearch',
    description: 'Find in files',
    group: 'Navigation',
    defaultCombo: 'Mod+Shift+F',
  },
  { id: 'toggleSidebar', description: 'Toggle sidebar', group: 'Layout', defaultCombo: 'Mod+B' },
  {
    id: 'toggleExplorer',
    description: 'Toggle explorer',
    group: 'Layout',
    defaultCombo: 'Mod+Shift+E',
  },
  { id: 'newSession', description: 'New session', group: 'Sessions', defaultCombo: 'Mod+N' },
  { id: 'openSettings', description: 'Open settings', group: 'General', defaultCombo: 'Mod+,' },
  // Save the active document (K2). The Monaco editor also binds Ctrl/Cmd+S when it has
  // focus; this global entry makes the SAME save reachable from anywhere else (terminal,
  // sidebar, filter input). Both route to the active doc's registered save, which is
  // self-guarded (clean buffer / in-flight → no-op), so a double-fire is harmless.
  { id: 'save', description: 'Save file', group: 'General', defaultCombo: 'Mod+S' },
  // Undo/redo for file-explorer operations (create, rename, move, copy). These are
  // intentionally NOT in the allowed-while-typing set: when an editor or input is
  // focused, Ctrl+Z must go to that widget (Monaco handles its own undo stack).
  // isTypingEntry + the .monaco-editor ancestor check in app.tsx ensure the global
  // handler skips when the user is typing, so Monaco text-undo is never hijacked.
  { id: 'undo', description: 'Undo file operation', group: 'Explorer', defaultCombo: 'Mod+Z' },
  {
    id: 'redo',
    description: 'Redo file operation',
    group: 'Explorer',
    defaultCombo: 'Mod+Shift+Z',
  },
];

/** Minimal structural shape of a keydown — avoids a DOM-lib dependency so this
 *  module type-checks in both the node and webview tsconfigs. DOM KeyboardEvent
 *  is structurally compatible. */
export interface KeyEvt {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** Capture a normalized combo string from a keydown, or null if only modifiers. */
export function comboFromEvent(e: KeyEvt): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

/** Does a keydown match a combo string? */
export function matchCombo(e: KeyEvt, combo: string): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const primary = isMac ? !!e.metaKey : !!e.ctrlKey;
  if (mods.has('Mod') !== primary) return false;
  if (mods.has('Alt') !== !!e.altKey) return false;
  if (mods.has('Shift') !== !!e.shiftKey) return false;
  const ek = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return ek === key;
}

/** Human-readable combo for display. */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => (p === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : p))
    .join(' + ');
}

/** Effective combo for an action: user override (if any) else default. */
export function effectiveCombo(action: ShortcutAction, overrides: Record<string, string>): string {
  return overrides[action.id] || action.defaultCombo;
}

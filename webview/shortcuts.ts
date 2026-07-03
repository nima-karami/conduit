// Keybinding registry + matching. Combos use a `Mod` token that means Ctrl on
// Windows/Linux and ⌘ on macOS, plus a literal `Ctrl` token that means the control key
// on EVERY platform (the built-in nav set is Ctrl-based because ⌘+Tab/⌘+` are OS-reserved
// on macOS). Bindings are data-driven so they can be rebound in Settings and matched by
// the window handlers in App.

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
  { id: 'navBack', description: 'Go back', group: 'Navigation', defaultCombo: 'Alt+ArrowLeft' },
  {
    id: 'navForward',
    description: 'Go forward',
    group: 'Navigation',
    defaultCombo: 'Alt+ArrowRight',
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
  {
    id: 'openGitHistory',
    description: 'Open git history',
    group: 'Navigation',
    defaultCombo: 'Mod+Shift+G',
  },
  { id: 'toggleSidebar', description: 'Toggle sidebar', group: 'Layout', defaultCombo: 'Mod+B' },
  {
    id: 'toggleExplorer',
    description: 'Toggle explorer',
    group: 'Layout',
    defaultCombo: 'Mod+Shift+E',
  },
  { id: 'newSession', description: 'New session', group: 'Sessions', defaultCombo: 'Mod+N' },
  { id: 'newWindow', description: 'New window', group: 'Sessions', defaultCombo: 'Mod+Shift+N' },
  { id: 'closeTab', description: 'Close editor tab', group: 'Editor', defaultCombo: 'Mod+W' },
  {
    id: 'reopenClosedTab',
    description: 'Reopen closed tab',
    group: 'Editor',
    defaultCombo: 'Mod+Shift+T',
  },
  { id: 'openSettings', description: 'Open settings', group: 'General', defaultCombo: 'Mod+,' },
  // Global Save (K2) reachable outside the editor (terminal, sidebar, filter). Both this
  // and Monaco's own Ctrl+S route to the active doc's save, which self-guards (clean/
  // in-flight → no-op), so a double-fire is harmless.
  { id: 'save', description: 'Save file', group: 'General', defaultCombo: 'Mod+S' },
  // File-explorer undo/redo, intentionally NOT allowed-while-typing: when an editor/input
  // is focused Ctrl+Z must reach that widget (Monaco's own undo). isTypingEntry + the
  // .monaco-editor ancestor check in app.tsx skip the global handler while typing.
  { id: 'undo', description: 'Undo file operation', group: 'Explorer', defaultCombo: 'Mod+Z' },
  {
    id: 'redo',
    description: 'Redo file operation',
    group: 'Explorer',
    defaultCombo: 'Mod+Shift+Z',
  },
  // Built-in navigation: literal Ctrl on every platform (⌘+Tab/⌘+` are OS-reserved on
  // macOS). Rebindable like the rest; navGoToTab's 1…9 range is intrinsic, only its prefix.
  {
    id: 'navNextTab',
    description: 'Next tab',
    group: 'Built-in navigation',
    defaultCombo: 'Ctrl+Tab',
  },
  {
    id: 'navPrevTab',
    description: 'Previous tab',
    group: 'Built-in navigation',
    defaultCombo: 'Ctrl+Shift+Tab',
  },
  {
    id: 'navPrevTabPage',
    description: 'Previous tab (Page Up)',
    group: 'Built-in navigation',
    defaultCombo: 'Ctrl+PageUp',
  },
  {
    id: 'navNextTabPage',
    description: 'Next tab (Page Down)',
    group: 'Built-in navigation',
    defaultCombo: 'Ctrl+PageDown',
  },
  {
    id: 'navFocusTerminal',
    description: 'Toggle terminal focus',
    group: 'Built-in navigation',
    defaultCombo: 'Ctrl+`',
  },
  {
    id: 'navGoToTab',
    description: 'Go to tab 1–9',
    group: 'Built-in navigation',
    defaultCombo: 'Ctrl+1…9',
  },
];

/** Minimal structural shape of a keydown — avoids a DOM-lib dependency so this
 *  module type-checks in both the node and webview tsconfigs. DOM KeyboardEvent
 *  is structurally compatible. */
export interface KeyEvt {
  key: string;
  // Physical key code; used to normalize the backquote independent of layout/shift.
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

// The navGoToTab family: a rebindable modifier prefix + the intrinsic 1–9 range.
const DIGIT_FAMILY = '1…9';

function keyToken(e: KeyEvt): string {
  if (e.code === 'Backquote') return '`';
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
// Windows delivers thumb buttons as the per-window `app-command` (browser-backward/forward),
// not as DOM button 3/4. The renderer gates its DOM thumb-button path off here so a single
// physical press navigates exactly once (host app-command is authoritative on Windows; §3.3).
export const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);

/** Capture a normalized combo string from a keydown, or null if only modifiers. */
export function comboFromEvent(e: KeyEvt): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  // Literal Ctrl is distinct from Mod only on macOS (where Mod is ⌘). Elsewhere the ctrl
  // key IS the primary modifier, already recorded as Mod above.
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // A modified digit 1–9 records as the navGoToTab family prefix; a bare digit is literal.
  if (parts.length > 0 && /^[1-9]$/.test(k)) parts.push(DIGIT_FAMILY);
  else parts.push(keyToken(e));
  return parts.join('+');
}

/** Does a keydown match a combo string? */
export function matchCombo(e: KeyEvt, combo: string): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  // On macOS Mod (⌘) and Ctrl (control) are independent keys; elsewhere both tokens mean
  // the ctrl key, so a stored Ctrl+… nav combo still matches on every platform.
  const expectMeta = isMac ? mods.has('Mod') : false;
  const expectCtrl = isMac ? mods.has('Ctrl') : mods.has('Mod') || mods.has('Ctrl');
  if (!!e.metaKey !== expectMeta) return false;
  if (!!e.ctrlKey !== expectCtrl) return false;
  if (mods.has('Alt') !== !!e.altKey) return false;
  if (mods.has('Shift') !== !!e.shiftKey) return false;
  if (key === DIGIT_FAMILY) return /^[1-9]$/.test(e.key);
  return keyToken(e) === key;
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

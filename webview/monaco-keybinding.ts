/**
 * Translate a `webview/shortcuts.ts` combo string into a Monaco keybinding number, so a rebound
 * editor-scoped action actually changes what the editor listens for instead of only changing
 * what Settings prints. monaco.KeyMod / monaco.KeyCode are INJECTED so this module needs no
 * runtime monaco import and stays testable in node.
 */

export interface MonacoKeyTables {
  /** monaco.KeyMod.CtrlCmd */
  CtrlCmd: number;
  /** monaco.KeyMod.Shift */
  Shift: number;
  /** monaco.KeyMod.Alt */
  Alt: number;
  /** monaco.KeyMod.WinCtrl — the literal control key, distinct from CtrlCmd on macOS. */
  WinCtrl: number;
  /** monaco.KeyCode entries by NAME, e.g. { F5: 68, KeyS: 49, Digit1: 22 }. */
  keyCodes: Record<string, number>;
}

/** Named and punctuation tokens → monaco.KeyCode names. Punctuation is the UNSHIFTED US-layout
 *  character only: a shifted one ('>') is what `e.key` reports for Shift+., and Monaco has no
 *  code for it. */
const NAMED_KEY_CODES: Readonly<Record<string, string>> = {
  ArrowLeft: 'LeftArrow',
  ArrowRight: 'RightArrow',
  ArrowUp: 'UpArrow',
  ArrowDown: 'DownArrow',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Space: 'Space',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};

/** The combo's final token → the monaco.KeyCode NAME to look up. */
export function monacoKeyCodeName(token: string): string | null {
  if (/^F\d{1,2}$/i.test(token)) return token.toUpperCase();
  if (/^[a-z]$/i.test(token)) return `Key${token.toUpperCase()}`;
  if (/^\d$/.test(token)) return `Digit${token}`;
  return Object.hasOwn(NAMED_KEY_CODES, token) ? NAMED_KEY_CODES[token] : null;
}

export function monacoKeybindingFor(combo: string, tables: MonacoKeyTables): number | null {
  if (!combo) return null;
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));

  const name = monacoKeyCodeName(key);
  if (name === null) return null;
  const code = tables.keyCodes[name];
  if (code === undefined) return null;

  let binding = code;
  if (mods.has('Mod')) binding |= tables.CtrlCmd;
  if (mods.has('Ctrl')) binding |= tables.WinCtrl;
  if (mods.has('Alt')) binding |= tables.Alt;
  if (mods.has('Shift')) binding |= tables.Shift;
  return binding;
}

export interface MonacoChord {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  keyCode: number;
}

const TOKEN_BY_KEY_CODE_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NAMED_KEY_CODES).map(([token, name]) => [name, token]),
);

/** The inverse of `monacoKeyCodeName`. */
function comboToken(keyCodeName: string): string | null {
  if (/^F\d{1,2}$/.test(keyCodeName)) return keyCodeName;
  const letter = /^Key([A-Z])$/.exec(keyCodeName);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(keyCodeName);
  if (digit) return digit[1];
  return Object.hasOwn(TOKEN_BY_KEY_CODE_NAME, keyCodeName)
    ? TOKEN_BY_KEY_CODE_NAME[keyCodeName]
    : null;
}

/** A resolved Monaco chord (OS-specific ctrl/meta) → combo string in canonical modifier order,
 *  or null when the key has no combo token or the chord uses the Windows key (no grammar token). */
export function comboFromChord(
  chord: MonacoChord,
  keyCodeNames: Readonly<Record<number, string>>,
  mac: boolean,
): string | null {
  const name = keyCodeNames[chord.keyCode];
  const token = name === undefined ? null : comboToken(name);
  if (token === null) return null;
  if (!mac && chord.metaKey) return null;
  const parts: string[] = [];
  if (mac ? chord.metaKey : chord.ctrlKey) parts.push('Mod');
  if (mac && chord.ctrlKey) parts.push('Ctrl');
  if (chord.altKey) parts.push('Alt');
  if (chord.shiftKey) parts.push('Shift');
  parts.push(token);
  return parts.join('+');
}

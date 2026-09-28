/**
 * Chord capture and validation for editor-scoped Shortcuts rows (nav-keybindings spec §3).
 * App rows keep `comboFromEvent`; these rows record the PHYSICAL key, because Monaco resolves
 * chords by US-layout position, and refuse chords Monaco can't bind or that would type text.
 */

import { monacoKeyCodeName } from './monaco-keybinding';
import type { KeyEvt } from './shortcuts';

const UNBINDABLE = "This key can't be bound in the editor";
const TYPES_TEXT = 'This key types text in the editor';

const DIGIT_FAMILY = '1…9';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
const TYPING_NAMED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Space', 'Delete']);

/** `e.code` → combo token for the keys whose `e.key` depends on layout or modifiers. */
const CODE_TOKENS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
};

function physicalToken(e: KeyEvt): string {
  const code = e.code ?? '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (Object.hasOwn(CODE_TOKENS, code)) return CODE_TOKENS[code];
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** Editor-row capture: the key token comes from `e.code`, named keys (F12, ArrowLeft) from
 *  `e.key`. Modifier-only ⇒ null. A modified 1–9 yields the '1…9' family token, as
 *  `comboFromEvent` does. */
export function editorComboFromEvent(e: KeyEvt, mac: boolean): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const token = physicalToken(e);
  parts.push(parts.length > 0 && /^[1-9]$/.test(token) ? DIGIT_FAMILY : token);
  return parts.join('+');
}

/** null = the combo can be bound on an editor row; otherwise the reason it can't. */
export function validateEditorCombo(combo: string): string | null {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (key === DIGIT_FAMILY || monacoKeyCodeName(key) === null) return UNBINDABLE;
  const unmodified = mods.length === 0 || (mods.length === 1 && mods[0] === 'Shift');
  if (unmodified && (key.length === 1 || TYPING_NAMED_KEYS.has(key))) return TYPES_TEXT;
  return null;
}

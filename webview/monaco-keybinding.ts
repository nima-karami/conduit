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

/** The combo's final token → the monaco.KeyCode NAME to look up. */
function keyCodeName(token: string): string | null {
  if (/^F\d{1,2}$/i.test(token)) return token.toUpperCase();
  if (/^[a-z]$/i.test(token)) return `Key${token.toUpperCase()}`;
  if (/^\d$/.test(token)) return `Digit${token}`;
  return null;
}

export function monacoKeybindingFor(combo: string, tables: MonacoKeyTables): number | null {
  if (!combo) return null;
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));

  const name = keyCodeName(key);
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

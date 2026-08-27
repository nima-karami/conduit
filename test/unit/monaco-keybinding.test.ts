import { describe, expect, it } from 'vitest';
import { type MonacoKeyTables, monacoKeybindingFor } from '../../webview/monaco-keybinding';

/** Stand-ins for monaco.KeyMod / monaco.KeyCode; the real values are injected at runtime. */
const TABLES: MonacoKeyTables = {
  CtrlCmd: 1 << 11,
  Shift: 1 << 10,
  Alt: 1 << 9,
  WinCtrl: 1 << 8,
  keyCodes: { F5: 68, F12: 75, KeyS: 49, KeyZ: 56, Digit1: 22 },
};

describe('monacoKeybindingFor', () => {
  it('maps a bare function key', () => {
    expect(monacoKeybindingFor('F5', TABLES)).toBe(68);
  });

  it('maps Alt+F5 and Shift+Alt+F5', () => {
    expect(monacoKeybindingFor('Alt+F5', TABLES)).toBe(TABLES.Alt | 68);
    expect(monacoKeybindingFor('Shift+Alt+F5', TABLES)).toBe(TABLES.Shift | TABLES.Alt | 68);
  });

  it('maps Mod to CtrlCmd and a literal Ctrl to WinCtrl', () => {
    expect(monacoKeybindingFor('Mod+S', TABLES)).toBe(TABLES.CtrlCmd | 49);
    expect(monacoKeybindingFor('Ctrl+S', TABLES)).toBe(TABLES.WinCtrl | 49);
  });

  it('maps a single letter case-insensitively', () => {
    expect(monacoKeybindingFor('Alt+z', TABLES)).toBe(TABLES.Alt | 56);
  });

  it('maps a bare digit', () => {
    expect(monacoKeybindingFor('Mod+1', TABLES)).toBe(TABLES.CtrlCmd | 22);
  });

  it('returns null for a key monaco has no code for', () => {
    expect(monacoKeybindingFor('Alt+F19', TABLES)).toBeNull();
  });

  it('returns null for the navGoToTab digit family, which monaco cannot express', () => {
    expect(monacoKeybindingFor('Mod+1…9', TABLES)).toBeNull();
  });

  it('returns null for an empty combo', () => {
    expect(monacoKeybindingFor('', TABLES)).toBeNull();
  });
});

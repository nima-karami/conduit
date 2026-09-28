import { describe, expect, it } from 'vitest';
import {
  comboFromChord,
  type MonacoKeyTables,
  monacoKeybindingFor,
  monacoKeyCodeName,
} from '../../webview/monaco-keybinding';

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

describe('monacoKeybindingFor — widened translation', () => {
  const NEW_TOKENS: Record<string, string> = {
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
  const WIDE: MonacoKeyTables = {
    ...TABLES,
    keyCodes: Object.fromEntries(Object.values(NEW_TOKENS).map((name, i) => [name, 100 + i])),
  };
  const MODS: [string, number][] = [
    ['', 0],
    ['Mod+', WIDE.CtrlCmd],
    ['Ctrl+', WIDE.WinCtrl],
    ['Alt+', WIDE.Alt],
    ['Shift+', WIDE.Shift],
    ['Mod+Alt+Shift+', WIDE.CtrlCmd | WIDE.Alt | WIDE.Shift],
  ];

  it('translates arrows, nav keys and unshifted punctuation with every modifier', () => {
    for (const [token, name] of Object.entries(NEW_TOKENS)) {
      expect(monacoKeyCodeName(token)).toBe(name);
      for (const [prefix, mods] of MODS) {
        expect(monacoKeybindingFor(`${prefix}${token}`, WIDE)).toBe(WIDE.keyCodes[name] | mods);
      }
    }
  });

  it('refuses shifted punctuation and the digit family', () => {
    expect(monacoKeybindingFor('Shift+>', WIDE)).toBeNull();
    expect(monacoKeybindingFor('Ctrl+1…9', WIDE)).toBeNull();
    expect(monacoKeyCodeName('>')).toBeNull();
  });
});

describe('comboFromChord', () => {
  const NAMES: Record<number, string> = {
    90: 'Slash',
    41: 'KeyK',
    70: 'F12',
    15: 'LeftArrow',
    3: 'Backslash',
  };
  const chord = (
    over: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }>,
    keyCode: number,
  ) => ({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
    keyCode,
  });

  it('round-trips monacoKeybindingFor', () => {
    expect(comboFromChord(chord({ ctrlKey: true }, 90), NAMES, false)).toBe('Mod+/');
    expect(comboFromChord(chord({ metaKey: true, ctrlKey: true }, 41), NAMES, true)).toBe(
      'Mod+Ctrl+K',
    );
    expect(comboFromChord(chord({ shiftKey: true, altKey: true }, 70), NAMES, false)).toBe(
      'Alt+Shift+F12',
    );
    expect(comboFromChord(chord({ altKey: true }, 15), NAMES, false)).toBe('Alt+ArrowLeft');
    expect(comboFromChord(chord({ ctrlKey: true }, 3), NAMES, false)).toBe('Mod+\\');
  });

  it('is null off-mac for the Windows key, and for a key with no combo token', () => {
    expect(comboFromChord(chord({ metaKey: true }, 41), NAMES, false)).toBeNull();
    expect(comboFromChord(chord({ ctrlKey: true }, 999), NAMES, false)).toBeNull();
  });
});

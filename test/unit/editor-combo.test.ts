import { describe, expect, it } from 'vitest';
import { editorComboFromEvent, validateEditorCombo } from '../../webview/editor-combo';

const TYPES = 'This key types text in the editor';
const UNBINDABLE = "This key can't be bound in the editor";

describe('validateEditorCombo', () => {
  it('refuses typing chords', () => {
    for (const c of ['D', 'Shift+D', 'Enter', 'Tab', 'Space', 'Backspace', 'Delete', '.']) {
      expect(validateEditorCombo(c), c).toBe(TYPES);
    }
  });

  it('refuses unbindable', () => {
    expect(validateEditorCombo('Mod+>')).toBe(UNBINDABLE);
    expect(validateEditorCombo('Ctrl+1…9')).toBe(UNBINDABLE);
  });

  it('accepts', () => {
    for (const c of ['F12', 'Alt+D', 'Mod+Shift+ArrowDown', 'Ctrl+F12', 'ArrowUp', 'Home']) {
      expect(validateEditorCombo(c), c).toBeNull();
    }
  });
});

describe('editorComboFromEvent', () => {
  it('mac ⌥D records the letter from keyCode, not the ∂ it types', () => {
    expect(editorComboFromEvent({ altKey: true, key: '∂', code: 'KeyD', keyCode: 68 }, true)).toBe(
      'Alt+D',
    );
  });

  // Monaco resolves on e.keyCode (keyboardEvent.js extractKeyCode), which on AZERTY is the
  // printed letter's code, not the US-position e.code.
  it('AZERTY records the key Monaco will resolve (keyCode), not e.code', () => {
    expect(
      editorComboFromEvent({ ctrlKey: true, key: 'a', code: 'KeyQ', keyCode: 65 }, false),
    ).toBe('Mod+A');
  });

  it('maps the OEM keyCodes to their unshifted punctuation token', () => {
    const oem: [number, string][] = [
      [186, ';'],
      [187, '='],
      [188, ','],
      [189, '-'],
      [190, '.'],
      [191, '/'],
      [192, '`'],
      [219, '['],
      [220, '\\'],
      [221, ']'],
      [222, "'"],
    ];
    for (const [keyCode, token] of oem) {
      expect(
        editorComboFromEvent({ altKey: true, key: '?', keyCode }, false),
        String(keyCode),
      ).toBe(`Alt+${token}`);
    }
  });

  it('ignores a modifier-only keydown', () => {
    expect(
      editorComboFromEvent({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }, false),
    ).toBe(null);
    expect(editorComboFromEvent({ altKey: true, key: 'Alt', code: 'AltLeft' }, true)).toBeNull();
  });

  it('records a modified digit as the 1…9 family and a bare one literally', () => {
    expect(
      editorComboFromEvent({ ctrlKey: true, key: '5', code: 'Digit5', keyCode: 53 }, false),
    ).toBe('Mod+1…9');
    expect(editorComboFromEvent({ key: '5', code: 'Digit5', keyCode: 53 }, false)).toBe('5');
  });

  it('takes punctuation and Space from keyCode, named keys from e.key', () => {
    expect(
      editorComboFromEvent({ shiftKey: true, key: '>', code: 'Period', keyCode: 190 }, false),
    ).toBe('Shift+.');
    expect(
      editorComboFromEvent({ ctrlKey: true, key: ' ', code: 'Space', keyCode: 32 }, false),
    ).toBe('Mod+Space');
    expect(editorComboFromEvent({ key: 'F12', code: 'F12' }, false)).toBe('F12');
    expect(editorComboFromEvent({ altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' }, false)).toBe(
      'Alt+ArrowLeft',
    );
  });

  it('Mod is ⌘ on mac and Ctrl elsewhere; a literal Ctrl only on mac', () => {
    expect(editorComboFromEvent({ metaKey: true, key: 'F12', code: 'F12' }, true)).toBe('Mod+F12');
    expect(editorComboFromEvent({ ctrlKey: true, key: 'F12', code: 'F12' }, true)).toBe('Ctrl+F12');
    expect(editorComboFromEvent({ ctrlKey: true, key: 'F12', code: 'F12' }, false)).toBe('Mod+F12');
  });
});

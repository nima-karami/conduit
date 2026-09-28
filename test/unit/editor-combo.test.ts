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
  it('mac ⌥D records the physical letter', () => {
    expect(editorComboFromEvent({ altKey: true, key: '∂', code: 'KeyD' }, true)).toBe('Alt+D');
  });

  it('AZERTY records US position', () => {
    expect(editorComboFromEvent({ ctrlKey: true, key: 'a', code: 'KeyQ' }, false)).toBe('Mod+Q');
  });

  it('ignores a modifier-only keydown', () => {
    expect(
      editorComboFromEvent({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }, false),
    ).toBe(null);
    expect(editorComboFromEvent({ altKey: true, key: 'Alt', code: 'AltLeft' }, true)).toBeNull();
  });

  it('records a modified digit as the 1…9 family and a bare one literally', () => {
    expect(editorComboFromEvent({ ctrlKey: true, key: '5', code: 'Digit5' }, false)).toBe(
      'Mod+1…9',
    );
    expect(editorComboFromEvent({ key: '5', code: 'Digit5' }, false)).toBe('5');
  });

  it('takes punctuation and Space from the physical key, named keys from e.key', () => {
    expect(editorComboFromEvent({ shiftKey: true, key: '>', code: 'Period' }, false)).toBe(
      'Shift+.',
    );
    expect(editorComboFromEvent({ ctrlKey: true, key: ' ', code: 'Space' }, false)).toBe(
      'Mod+Space',
    );
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

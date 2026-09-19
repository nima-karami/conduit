import { describe, expect, it } from 'vitest';
import { decideShortcut, type ShortcutContext } from '../../webview/decide-shortcut';

const base: ShortcutContext = {
  inTerminal: false,
  inEditor: false,
  inFormField: false,
  defaultPrevented: false,
  combo: 'Mod+P',
};

describe('decideShortcut', () => {
  it('allows the escape hatch while the terminal is focused', () => {
    expect(decideShortcut({ ...base, inTerminal: true, combo: 'Ctrl+`' }, 'navFocusTerminal')).toBe(
      true,
    );
  });

  it('allows openGlobalSearch while the terminal is focused', () => {
    expect(
      decideShortcut({ ...base, inTerminal: true, combo: 'Mod+Shift+F' }, 'openGlobalSearch'),
    ).toBe(true);
  });

  it('still blocks other actions while the terminal is focused', () => {
    expect(decideShortcut({ ...base, inTerminal: true }, 'openSearch')).toBe(false);
    expect(decideShortcut({ ...base, inTerminal: true, combo: 'Ctrl+Tab' }, 'navNextTab')).toBe(
      false,
    );
    // Mod+S is global everywhere else (typing-guard) — the terminal reserve is not that list.
    expect(decideShortcut({ ...base, inTerminal: true, combo: 'Mod+S' }, 'save')).toBe(false);
    expect(decideShortcut({ ...base, inTerminal: true, combo: 'Mod+Shift+F' }, 'openSearch')).toBe(
      false,
    );
  });

  it('skips when a widget already consumed the key (defaultPrevented)', () => {
    expect(decideShortcut({ ...base, defaultPrevented: true }, 'openSearch')).toBe(false);
    // Editor pass-through: a key Monaco consumed (Ctrl+Z) is skipped without any special-casing.
    expect(
      decideShortcut({ ...base, inEditor: true, defaultPrevented: true, combo: 'Mod+Z' }, 'undo'),
    ).toBe(false);
  });

  it('still allows only Mod+S and Escape in a form field', () => {
    expect(decideShortcut({ ...base, inFormField: true, combo: 'Mod+S' }, 'save')).toBe(true);
    expect(decideShortcut({ ...base, inFormField: true, combo: 'Escape' }, 'closeTab')).toBe(true);
    expect(decideShortcut({ ...base, inFormField: true }, 'openSearch')).toBe(false);
    // Widening the terminal reserve must not leak into the form-field rule.
    expect(
      decideShortcut({ ...base, inFormField: true, combo: 'Mod+Shift+F' }, 'openGlobalSearch'),
    ).toBe(false);
  });

  it('otherwise fires (editor pass-through / plain focus)', () => {
    expect(decideShortcut(base, 'openSearch')).toBe(true);
    expect(decideShortcut({ ...base, inEditor: true }, 'openSearch')).toBe(true);
  });

  it('evaluates the terminal reserved rule before defaultPrevented', () => {
    expect(
      decideShortcut(
        { ...base, inTerminal: true, defaultPrevented: true, combo: 'Ctrl+`' },
        'navFocusTerminal',
      ),
    ).toBe(true);
  });
});

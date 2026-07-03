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
  it('in the terminal fires only navFocusTerminal', () => {
    expect(decideShortcut({ ...base, inTerminal: true, combo: 'Ctrl+`' }, 'navFocusTerminal')).toBe(
      true,
    );
    expect(decideShortcut({ ...base, inTerminal: true }, 'openSearch')).toBe(false);
    expect(decideShortcut({ ...base, inTerminal: true, combo: 'Ctrl+Tab' }, 'navNextTab')).toBe(
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

  it('in a form field fires only combos allowed while typing', () => {
    expect(decideShortcut({ ...base, inFormField: true, combo: 'Mod+S' }, 'save')).toBe(true);
    expect(decideShortcut({ ...base, inFormField: true }, 'openSearch')).toBe(false);
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

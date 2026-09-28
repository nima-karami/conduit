import { describe, expect, it } from 'vitest';
import {
  buildNavRules,
  canonicalCombo,
  isNavOverridden,
  navDispatchCommandId,
  navShortcutActions,
} from '../../webview/nav-keybindings';

/** Distinct number per combo so a rule's keybinding names the combo it came from. */
const CODES: Record<string, number> = {
  F12: 1,
  'Mod+F12': 2,
  'Shift+F12': 3,
  'Alt+D': 4,
  'Alt+R': 5,
};
const tb = (combo: string): number | null => CODES[combo] ?? null;

describe('navShortcutActions', () => {
  it('returns the three rows in order with their monacoCommand', () => {
    expect(navShortcutActions().map((a) => [a.id, a.monacoCommand, a.defaultCombo])).toEqual([
      ['goToDefinition', 'editor.action.revealDefinition', 'F12'],
      ['goToImplementation', 'editor.action.goToImplementation', 'Mod+F12'],
      ['goToReferences', 'editor.action.goToReferences', 'Shift+F12'],
    ]);
  });
});

describe('canonicalCombo', () => {
  it('orders modifiers Mod, Ctrl, Alt, Shift before the key', () => {
    expect(canonicalCombo('Shift+Alt+F5')).toBe('Alt+Shift+F5');
    expect(canonicalCombo('Shift+Ctrl+Mod+Alt+K')).toBe('Mod+Ctrl+Alt+Shift+K');
    expect(canonicalCombo('F12')).toBe('F12');
  });
});

describe('isNavOverridden', () => {
  it('is true only for a nav row whose stored combo differs from its default', () => {
    expect(isNavOverridden('editor.action.revealDefinition', { goToDefinition: 'Alt+D' })).toBe(
      true,
    );
    expect(isNavOverridden('editor.action.revealDefinition', { goToDefinition: 'F12' })).toBe(
      false,
    );
    expect(isNavOverridden('editor.action.revealDefinition', {})).toBe(false);
    expect(isNavOverridden('editor.action.peekDefinition', { goToDefinition: 'Alt+D' })).toBe(
      false,
    );
  });
});

describe('buildNavRules', () => {
  it('is empty with no overrides', () => {
    expect(buildNavRules({}, tb)).toEqual([]);
    expect(buildNavRules({ goToDefinition: 'F12' }, tb)).toEqual([]);
  });

  it('one override removes every default chord and adds one dispatch rule', () => {
    expect(buildNavRules({ goToDefinition: 'Alt+D' }, tb)).toEqual([
      { command: '-editor.action.revealDefinition', keybinding: tb('F12') },
      { command: '-editor.action.revealDefinition', keybinding: tb('Mod+F12') },
      {
        command: navDispatchCommandId('goToDefinition'),
        keybinding: tb('Alt+D'),
        when: 'editorTextFocus',
      },
    ]);
    expect(buildNavRules({ goToReferences: 'Alt+R' }, tb)).toEqual([
      { command: '-editor.action.goToReferences', keybinding: tb('Shift+F12') },
      {
        command: 'conduit.dispatch.goToReferences',
        keybinding: tb('Alt+R'),
        when: 'editorTextFocus',
      },
    ]);
  });

  it("swap yields both commands' rules and no leftovers", () => {
    const rules = buildNavRules({ goToDefinition: 'Shift+F12', goToReferences: 'F12' }, tb);
    expect(rules).toEqual([
      { command: '-editor.action.revealDefinition', keybinding: tb('F12') },
      { command: '-editor.action.revealDefinition', keybinding: tb('Mod+F12') },
      {
        command: 'conduit.dispatch.goToDefinition',
        keybinding: tb('Shift+F12'),
        when: 'editorTextFocus',
      },
      { command: '-editor.action.goToReferences', keybinding: tb('Shift+F12') },
      {
        command: 'conduit.dispatch.goToReferences',
        keybinding: tb('F12'),
        when: 'editorTextFocus',
      },
    ]);
    expect(rules.some((r) => r.command.includes('Implementation'))).toBe(false);
  });

  it('is idempotent', () => {
    const o = { goToDefinition: 'Alt+D', goToImplementation: 'Alt+R' };
    expect(buildNavRules(o, tb)).toEqual(buildNavRules(o, tb));
  });

  it('unbindable override keeps removals, adds nothing', () => {
    expect(buildNavRules({ goToDefinition: 'Alt+∂' }, tb)).toEqual([
      { command: '-editor.action.revealDefinition', keybinding: tb('F12') },
      { command: '-editor.action.revealDefinition', keybinding: tb('Mod+F12') },
    ]);
  });
});

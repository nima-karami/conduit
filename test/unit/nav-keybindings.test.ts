import { describe, expect, it } from 'vitest';
import {
  buildNavRules,
  canonicalCombo,
  dropNavChords,
  findConflicts,
  formatMonacoHint,
  humanizeCommandId,
  isNavOverridden,
  navDispatchCommandId,
  navMenuHints,
  navShortcutActions,
} from '../../webview/nav-keybindings';

/** Distinct number per combo so a rule's keybinding names the combo it came from. */
const CODES: Record<string, number> = {
  F12: 1,
  'Mod+F12': 2,
  'Shift+F12': 3,
  'Alt+D': 4,
  'Alt+R': 5,
  'Alt+I': 6,
  'Alt+Z': 7,
  'Mod+S': 8,
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

  it("overriding only Implementations also removes Definition's Mod+F12, so Ctrl+F12 can't fall through to it", () => {
    expect(buildNavRules({ goToImplementation: 'Alt+I' }, tb)).toEqual([
      { command: '-editor.action.revealDefinition', keybinding: tb('Mod+F12') },
      { command: '-editor.action.goToImplementation', keybinding: tb('Mod+F12') },
      {
        command: 'conduit.dispatch.goToImplementation',
        keybinding: tb('Alt+I'),
        when: 'editorTextFocus',
      },
    ]);
  });

  it('unbindable override keeps removals, adds nothing', () => {
    expect(buildNavRules({ goToDefinition: 'Alt+∂' }, tb)).toEqual([
      { command: '-editor.action.revealDefinition', keybinding: tb('F12') },
      { command: '-editor.action.revealDefinition', keybinding: tb('Mod+F12') },
    ]);
  });
});

describe('findConflicts', () => {
  const COMMENT = {
    command: 'editor.action.commentLine',
    label: 'Toggle Line Comment',
    combo: 'Mod+/',
  };
  const OWN = {
    command: 'editor.action.revealDefinition',
    label: 'Go to Definition',
    combo: 'F12',
  };

  it('app conflict', () => {
    expect(findConflicts('goToDefinition', { goToDefinition: 'Mod+P' }, [])).toEqual([
      {
        kind: 'app',
        actionId: 'openSearch',
        label: 'Search files & sessions',
        editorScoped: false,
      },
    ]);
  });

  it('marks a conflicting editor row as editorScoped', () => {
    expect(
      findConflicts('goToDefinition', { goToDefinition: 'Alt+R', goToReferences: 'Alt+R' }, []),
    ).toEqual([
      { kind: 'app', actionId: 'goToReferences', label: 'Go to References', editorScoped: true },
    ]);
  });

  it('monaco default conflict', () => {
    expect(findConflicts('goToDefinition', { goToDefinition: 'Mod+/' }, [COMMENT])).toEqual([
      { kind: 'monaco', command: 'editor.action.commentLine', label: 'Toggle Line Comment' },
    ]);
  });

  it('never against its own default', () => {
    expect(findConflicts('goToDefinition', {}, [OWN])).toEqual([]);
  });

  it("skips another nav built-in's default the rule set removes, but not other commands on the chord", () => {
    const other = { command: 'x.other', label: 'Other', combo: 'F12' };
    expect(
      findConflicts('goToReferences', { goToDefinition: 'Alt+D', goToReferences: 'F12' }, [
        OWN,
        other,
      ]),
    ).toEqual([{ kind: 'monaco', command: 'x.other', label: 'Other' }]);
  });

  it('compares canonical combos', () => {
    expect(
      findConflicts('goToDefinition', { goToDefinition: 'Shift+Alt+K' }, [
        { command: 'x.cmd', label: 'X', combo: 'Alt+Shift+K' },
      ]),
    ).toEqual([{ kind: 'monaco', command: 'x.cmd', label: 'X' }]);
  });

  it('code-viewer chords', () => {
    expect(findConflicts('goToDefinition', { goToDefinition: 'Alt+Z' }, [])).toEqual([
      { kind: 'codeViewer', label: 'Toggle Word Wrap' },
    ]);
  });

  it('app rows get only app conflicts', () => {
    expect(
      findConflicts('openSearch', {}, [{ command: 'x.cmd', label: 'X', combo: 'Mod+P' }]),
    ).toEqual([]);
    expect(findConflicts('openSearch', { goToDefinition: 'Mod+P' }, [])).toEqual([
      { kind: 'app', actionId: 'goToDefinition', label: 'Go to Definition', editorScoped: true },
    ]);
  });

  it('an unbound combo conflicts with nothing, including another unbound row', () => {
    expect(findConflicts('focusLeftGroup', {}, [])).toEqual([]);
    expect(findConflicts('focusRightGroup', {}, [])).toEqual([]);
  });
});

describe('dropNavChords', () => {
  it("drops a code-viewer binding equal to an overridden nav row's chord", () => {
    expect(dropNavChords([tb('Alt+Z') as number], { goToDefinition: 'Alt+Z' }, tb)).toEqual([]);
    expect(
      dropNavChords(
        [tb('Mod+S') as number, tb('Alt+Z') as number],
        { goToReferences: 'Mod+S' },
        tb,
      ),
    ).toEqual([tb('Alt+Z')]);
  });

  it('keeps everything when no nav row is overridden, or the override is the default', () => {
    expect(dropNavChords([tb('F12') as number, tb('Alt+Z') as number], {}, tb)).toEqual([1, 7]);
    expect(dropNavChords([tb('F12') as number], { goToDefinition: 'F12' }, tb)).toEqual([1]);
  });

  it("drops a non-overridden nav row's default chord another row took", () => {
    expect(dropNavChords([tb('F12') as number], { goToReferences: 'F12' }, tb)).toEqual([]);
  });
});

describe('humanizeCommandId', () => {
  it('turns the last id segment into words', () => {
    expect(humanizeCommandId('toggleFindRegex')).toBe('Toggle Find Regex');
    expect(humanizeCommandId('editor.action.insertCursorAbove')).toBe('Insert Cursor Above');
    expect(humanizeCommandId('cursorWordLeft')).toBe('Cursor Word Left');
    expect(humanizeCommandId('editor.action.goToLocations')).toBe('Go To Locations');
  });
});

describe('formatMonacoHint', () => {
  it("prints Monaco's compact style off-mac: Ctrl, Shift, Alt order joined by +", () => {
    expect(formatMonacoHint('Alt+D', false)).toBe('Alt+D');
    expect(formatMonacoHint('Mod+F12', false)).toBe('Ctrl+F12');
    expect(formatMonacoHint('Alt+Shift+F12', false)).toBe('Shift+Alt+F12');
    expect(formatMonacoHint('Mod+Alt+Shift+K', false)).toBe('Ctrl+Shift+Alt+K');
  });

  it('prints glyphs on mac, ⌃⇧⌥⌘ order, no separator', () => {
    expect(formatMonacoHint('Mod+F12', true)).toBe('⌘F12');
    expect(formatMonacoHint('Mod+Ctrl+Alt+Shift+K', true)).toBe('⌃⇧⌥⌘K');
  });
});

describe('navMenuHints', () => {
  it('hints follow the effective combo', () => {
    expect(navMenuHints({ goToDefinition: 'Alt+D' }, (c) => c.replace(/\+/g, ' + '))).toEqual({
      'editor.action.revealDefinition': 'Alt + D',
      'editor.action.goToImplementation': 'Mod + F12',
      'editor.action.goToReferences': 'Shift + F12',
    });
  });
});

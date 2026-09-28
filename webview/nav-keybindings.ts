/**
 * Pure model of the configurable code-navigation chords (docs/specs/2026-09-28-nav-keybindings.md):
 * which rows exist, when one counts as overridden, and the Monaco rule set that follows. No monaco
 * import — the Monaco side lives in `monaco-nav-keybindings.ts`.
 */

import { SHORTCUT_ACTIONS, type ShortcutAction } from './shortcuts';

/** Every default chord per nav built-in (monaco-editor goToCommands.js l.237/241/479/549).
 *  revealDefinition's second chord is its `isWeb` default, live in our renderer. */
const NAV_BUILTIN_DEFAULT_CHORDS: Readonly<Record<string, readonly string[]>> = {
  'editor.action.revealDefinition': ['F12', 'Mod+F12'],
  'editor.action.goToImplementation': ['Mod+F12'],
  'editor.action.goToReferences': ['Shift+F12'],
};

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** SHORTCUT_ACTIONS entries with scope 'editor' and a monacoCommand, in array order. */
export function navShortcutActions(): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter((a) => a.scope === 'editor' && a.monacoCommand);
}

/** Modifiers reordered Mod, Ctrl, Alt, Shift, then the key: 'Shift+Alt+F5' → 'Alt+Shift+F5'. */
export function canonicalCombo(combo: string): string {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** The stored override iff present and canonically different from the default, else undefined. */
export function navOverride(
  action: ShortcutAction,
  overrides: Readonly<Record<string, string>>,
): string | undefined {
  const stored = overrides[action.id];
  if (!stored || canonicalCombo(stored) === canonicalCombo(action.defaultCombo)) return undefined;
  return stored;
}

/** true iff monacoCommand belongs to a nav row with a navOverride. false for peek/find-all. */
export function isNavOverridden(
  monacoCommand: string,
  overrides: Readonly<Record<string, string>>,
): boolean {
  const action = navShortcutActions().find((a) => a.monacoCommand === monacoCommand);
  return !!action && navOverride(action, overrides) !== undefined;
}

export function navDispatchCommandId(actionId: string): string {
  return `conduit.dispatch.${actionId}`;
}

export interface NavKeybindingRule {
  command: string;
  keybinding: number;
  when?: string;
}

export function buildNavRules(
  overrides: Readonly<Record<string, string>>,
  toBinding: (combo: string) => number | null,
): NavKeybindingRule[] {
  const rules: NavKeybindingRule[] = [];
  for (const action of navShortcutActions()) {
    const override = navOverride(action, overrides);
    const builtin = action.monacoCommand;
    if (override === undefined || !builtin) continue;
    // No `when` on a removal: it then strips every `when` variant of the chord.
    for (const chord of NAV_BUILTIN_DEFAULT_CHORDS[builtin] ?? []) {
      const keybinding = toBinding(chord);
      if (keybinding !== null) rules.push({ command: `-${builtin}`, keybinding });
    }
    const keybinding = toBinding(override);
    if (keybinding !== null) {
      rules.push({ command: navDispatchCommandId(action.id), keybinding, when: 'editorTextFocus' });
    }
  }
  return rules;
}

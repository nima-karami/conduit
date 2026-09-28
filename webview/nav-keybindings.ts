/**
 * Pure model of the configurable code-navigation chords (docs/specs/2026-09-28-nav-keybindings.md):
 * which rows exist, when one counts as overridden, and the Monaco rule set that follows. No monaco
 * import — the Monaco side lives in `monaco-nav-keybindings.ts`.
 */

import { effectiveCombo, SHORTCUT_ACTIONS, type ShortcutAction } from './shortcuts';

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

export interface MonacoDefaultBinding {
  command: string;
  label: string;
  combo: string;
}

export type Conflict =
  | { kind: 'app'; actionId: string; label: string; editorScoped: boolean }
  | { kind: 'monaco'; command: string; label: string }
  | { kind: 'codeViewer'; label: string };

/** Code-viewer addAction/addCommand chords that are not SHORTCUT_ACTIONS rows — a mirror of
 *  code-viewer.tsx's Save and Toggle Word Wrap registrations, which the registry never sees. */
export const CODE_VIEWER_CHORDS: readonly { combo: string; label: string }[] = [
  { combo: 'Mod+S', label: 'Save File' },
  { combo: 'Alt+Z', label: 'Toggle Word Wrap' },
];

export function findConflicts(
  actionId: string,
  overrides: Readonly<Record<string, string>>,
  monacoDefaults: readonly MonacoDefaultBinding[],
): Conflict[] {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
  if (!action) return [];
  const combo = canonicalCombo(effectiveCombo(action, overrides));
  const conflicts: Conflict[] = SHORTCUT_ACTIONS.filter(
    (a) => a.id !== actionId && canonicalCombo(effectiveCombo(a, overrides)) === combo,
  ).map((a) => ({
    kind: 'app',
    actionId: a.id,
    label: a.description,
    editorScoped: a.scope === 'editor',
  }));
  if (action.scope !== 'editor') return conflicts;
  // A nav built-in's defaults are either this row's own or removed by the rule set once a row
  // takes their chord — never a live competitor.
  const navCommands = new Set(navShortcutActions().map((a) => a.monacoCommand));
  for (const d of monacoDefaults) {
    if (!navCommands.has(d.command) && canonicalCombo(d.combo) === combo) {
      conflicts.push({ kind: 'monaco', command: d.command, label: d.label });
    }
  }
  for (const c of CODE_VIEWER_CHORDS) {
    if (canonicalCombo(c.combo) === combo) conflicts.push({ kind: 'codeViewer', label: c.label });
  }
  return conflicts;
}

/** monacoCommand → format(effective combo) for the three nav rows. */
export function navMenuHints(
  overrides: Readonly<Record<string, string>>,
  format: (combo: string) => string,
): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const a of navShortcutActions()) {
    if (a.monacoCommand) hints[a.monacoCommand] = format(effectiveCombo(a, overrides));
  }
  return hints;
}

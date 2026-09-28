/**
 * The one owner of Monaco's window-global keybinding rules for the code-navigation rows
 * (docs/specs/2026-09-28-nav-keybindings.md §2.2). The rule set is built by the pure
 * `buildNavRules`; this module only hands it to Monaco and routes the dispatch commands.
 */

import * as monaco from 'monaco-editor';
import { EditorExtensionsRegistry } from 'monaco-editor/esm/vs/editor/browser/editorExtensions.js';
import { KeybindingsRegistry } from 'monaco-editor/esm/vs/platform/keybinding/common/keybindingsRegistry.js';
import { useEffect } from 'react';
import { comboFromChord, type MonacoKeyTables, monacoKeybindingFor } from './monaco-keybinding';
import {
  buildNavRules,
  type MonacoDefaultBinding,
  navDispatchCommandId,
  navShortcutActions,
} from './nav-keybindings';
import { isMac } from './shortcuts';
import { runNavCommand } from './ts-nav';

export const MONACO_KEY_TABLES: MonacoKeyTables = {
  CtrlCmd: monaco.KeyMod.CtrlCmd,
  Shift: monaco.KeyMod.Shift,
  Alt: monaco.KeyMod.Alt,
  WinCtrl: monaco.KeyMod.WinCtrl,
  // monaco.KeyCode is a reverse-mapped numeric enum; only the name→number direction is a table.
  keyCodes: Object.fromEntries(
    Object.entries(monaco.KeyCode).filter((e): e is [string, number] => typeof e[1] === 'number'),
  ),
};

// Identity, not path: a split pane may show one path in two editors.
const codeViewerEditors = new Set<monaco.editor.ICodeEditor>();

export function registerCodeViewerEditor(editor: monaco.editor.ICodeEditor): () => void {
  codeViewerEditors.add(editor);
  return () => {
    codeViewerEditors.delete(editor);
  };
}

// Keyed on the focused editor's identity, not a context key: a peek's embedded editor inherits
// its code-viewer parent's context keys (spec §2.2, H1).
function dispatch(monacoCommand: string): void {
  const focused = monaco.editor.getEditors().find((e) => e.hasTextFocus());
  if (!focused) return;
  if (codeViewerEditors.has(focused)) void runNavCommand(focused, monacoCommand);
  else focused.trigger('keyboard', monacoCommand, undefined);
}

export function useMonacoNavKeybindings(shortcuts: Readonly<Record<string, string>>): void {
  useEffect(() => {
    const commands = navShortcutActions().map((a) =>
      monaco.editor.addCommand({
        id: navDispatchCommandId(a.id),
        run: () => {
          if (a.monacoCommand) dispatch(a.monacoCommand);
        },
      }),
    );
    return () => {
      for (const c of commands) c.dispose();
    };
  }, []);

  useEffect(() => {
    const rules = monaco.editor.addKeybindingRules(
      buildNavRules(shortcuts, (combo) => monacoKeybindingFor(combo, MONACO_KEY_TABLES)),
    );
    return () => rules.dispose();
  }, [shortcuts]);
}

/** Monaco's single-chord editor-focus default bindings as combos, for the conflict notes. */
export function readMonacoDefaultBindings(): MonacoDefaultBinding[] {
  const keyCodeNames: Record<number, string> = Object.fromEntries(
    Object.entries(MONACO_KEY_TABLES.keyCodes).map(([name, code]) => [code, name]),
  );
  const labels = new Map(EditorExtensionsRegistry.getEditorActions().map((a) => [a.id, a.label]));
  const bindings: MonacoDefaultBinding[] = [];
  for (const { command, keybinding, when } of KeybindingsRegistry.getDefaultKeybindings()) {
    if (!command || command.startsWith('-') || keybinding?.chords.length !== 1) continue;
    const scope = when?.serialize() ?? '';
    if (!scope.includes('editorTextFocus') && !scope.includes('editorFocus')) continue;
    const combo = comboFromChord(keybinding.chords[0], keyCodeNames, isMac);
    if (combo) bindings.push({ command, label: labels.get(command) ?? command, combo });
  }
  return bindings;
}

/**
 * Pure builder for the code editor's context-menu item list (replaces Monaco's
 * off-theme native menu with the app's shared `ContextMenu`). React/Monaco-free
 * so it's unit-testable in node.
 *
 * Design notes (see docs/specs/archive/2026-06-11-ctx-menu-overhaul.md and
 * docs/specs/archive/2026-08-07-editor-navigation-parity.md):
 * - Editor is read-only today, so Cut/Paste are OMITTED (not greyed); the
 *   `readOnly` field is honoured so they reappear if it ever becomes editable.
 * - The navigation group runs Monaco's BUILT-IN commands (they became cross-file
 *   once the editor opener was registered), dispatched through `runNavCommand`
 *   so each one is bounded and can report "still indexing" honestly.
 * - No "Go to Source Definition": the bundled TypeScript services expose no
 *   `getSourceDefinitionAndBoundSpan`, and nothing under node_modules is indexed
 *   for it to map back from. A row that quietly behaved like Go to Definition
 *   would be worse than its absence.
 */

export interface EditorMenuContext {
  /** Editor is read-only — gates Cut/Paste (omitted entirely when true). */
  readOnly: boolean;
  /** A non-empty selection exists — gates Copy's enabled state. */
  hasSelection: boolean;
  /** Active model is TS/JS — gates the navigation group's enabled state. */
  canGoToDefinition: boolean;
}

/** How a menu item is dispatched against the editor. */
export type EditorMenuAction =
  | { kind: 'action'; actionId: string } // editor.getAction(actionId)?.run()
  | { kind: 'nav'; actionId: string } // built-in navigation, via runNavCommand
  | { kind: 'copy' } // clipboard copy of the current selection
  | { kind: 'mention' }; // send an @path#Lx-Ly reference for the selection to the terminal

export type EditorMenuIconKey =
  | 'copy'
  | 'search'
  | 'graph'
  | 'command'
  | 'doc'
  | 'mention'
  | 'history';

export interface EditorMenuItemSpec {
  /** Stable id for tests and React keys. */
  id: string;
  label: string;
  action: EditorMenuAction;
  iconKey?: EditorMenuIconKey;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** Accelerator shown on the row. Matches what the editor actually binds. */
  hint?: string;
}

/**
 * The navigation group, in VS Code's order. Peek Definition sits inline rather than behind a
 * "Peek ▸" submenu — the app's ContextMenu has no submenus, and adding them for one row is
 * a bigger change than this feature warrants.
 */
export const NAVIGATION: { id: string; label: string; actionId: string; hint?: string }[] = [
  {
    id: 'goToDefinition',
    label: 'Go to Definition',
    actionId: 'editor.action.revealDefinition',
    hint: 'F12',
  },
  {
    id: 'goToTypeDefinition',
    label: 'Go to Type Definition',
    actionId: 'editor.action.goToTypeDefinition',
  },
  {
    id: 'goToImplementations',
    label: 'Go to Implementations',
    actionId: 'editor.action.goToImplementation',
    hint: 'Ctrl+F12',
  },
  {
    id: 'goToReferences',
    label: 'Go to References',
    actionId: 'editor.action.goToReferences',
    hint: 'Shift+F12',
  },
  {
    id: 'peekDefinition',
    label: 'Peek Definition',
    actionId: 'editor.action.peekDefinition',
    hint: 'Alt+F12',
  },
  {
    id: 'findAllReferences',
    label: 'Find All References',
    actionId: 'editor.action.referenceSearch.trigger',
    hint: 'Shift+Alt+F12',
  },
];

/** Build the ordered context-menu item specs for the given editor context. */
export function buildEditorMenuItems(ctx: EditorMenuContext): EditorMenuItemSpec[] {
  const items: EditorMenuItemSpec[] = [];

  // Clipboard — only Copy, and only because the editor is read-only. If the
  // editor ever becomes editable, Cut/Paste join here ahead of Copy.
  if (!ctx.readOnly) {
    items.push(
      {
        id: 'cut',
        label: 'Cut',
        action: { kind: 'action', actionId: 'editor.action.clipboardCutAction' },
      },
      {
        id: 'paste',
        label: 'Paste',
        action: { kind: 'action', actionId: 'editor.action.clipboardPasteAction' },
      },
    );
  }
  items.push({
    id: 'copy',
    label: 'Copy',
    action: { kind: 'copy' },
    iconKey: 'copy',
    disabled: !ctx.hasSelection,
  });

  // Send the selection to the terminal as an @path#Lx-Ly reference (for the agent).
  // Only meaningful with a selection.
  if (ctx.hasSelection) {
    items.push({
      id: 'mention',
      label: 'Mention in terminal',
      action: { kind: 'mention' },
      iconKey: 'mention',
    });
  }

  // Navigation. Only the first row carries the icon: six icons in a row reads as a toolbar,
  // and the group is already set apart by its separator.
  items.push(
    ...NAVIGATION.map((n, i) => ({
      id: n.id,
      label: n.label,
      action: { kind: 'nav' as const, actionId: n.actionId },
      iconKey: i === 0 ? ('graph' as const) : undefined,
      disabled: !ctx.canGoToDefinition,
      separatorBefore: i === 0,
      hint: n.hint,
    })),
  );

  // Git blame — the current-line author/commit lens (git-blame); a no-op on untracked files.
  items.push({
    id: 'toggleGitBlame',
    label: 'Toggle Git Blame',
    action: { kind: 'action', actionId: 'agentdeck.toggleGitBlame' },
    iconKey: 'history',
  });

  // Search / palette.
  items.push(
    {
      id: 'find',
      label: 'Find',
      action: { kind: 'action', actionId: 'actions.find' },
      iconKey: 'search',
      separatorBefore: true,
    },
    {
      id: 'commandPalette',
      label: 'Command Palette',
      action: { kind: 'action', actionId: 'editor.action.quickCommand' },
      iconKey: 'command',
    },
  );

  // Whole-document + view.
  items.push(
    {
      id: 'selectAll',
      label: 'Select All',
      action: { kind: 'action', actionId: 'editor.action.selectAll' },
      separatorBefore: true,
    },
    {
      id: 'toggleWordWrap',
      label: 'Toggle Word Wrap',
      action: { kind: 'action', actionId: 'agentdeck.toggleWordWrap' },
      iconKey: 'doc',
    },
  );

  return items;
}

/**
 * Pure builder for the code editor's context-menu item list.
 *
 * The editor (CodeViewer) replaces Monaco's native, off-theme right-click menu
 * with the app's shared `ContextMenu`. This module decides WHICH items appear
 * and their enabled state purely from the editor context, with no React/Monaco
 * dependency — so it's deterministic and unit-testable in node. The component
 * maps each spec to a `MenuItem` (binding the real editor action + an icon).
 *
 * Design notes baked in here (see docs/specs/archive/2026-06-11-ctx-menu-overhaul.md):
 * - The editor is read-only today, so Cut/Paste are OMITTED (not shown disabled):
 *   a permanently read-only editor with greyed clipboard-mutation items is noise.
 *   The `readOnly` field is honoured so that if the editor ever becomes editable
 *   the items appear automatically.
 * - Go to Definition runs the CUSTOM worker-backed `agentdeck.goToDefinition`
 *   action (NOT Monaco's built-in reveal, which isn't reliably bundled); it's
 *   disabled for non-TS/JS models because the worker can't resolve those.
 * - Copy is present but disabled with no selection (discoverable, can't act on
 *   nothing).
 */

export interface EditorMenuContext {
  /** Editor is read-only — gates Cut/Paste (omitted entirely when true). */
  readOnly: boolean;
  /** A non-empty selection exists — gates Copy's enabled state. */
  hasSelection: boolean;
  /** Active model is TS/JS — gates Go to Definition's enabled state. */
  canGoToDefinition: boolean;
}

/** How a menu item is dispatched against the editor. */
export type EditorMenuAction =
  | { kind: 'action'; actionId: string } // editor.getAction(actionId)?.run()
  | { kind: 'copy' } // clipboard copy of the current selection
  | { kind: 'mention' }; // send an @path#Lx-Ly reference for the selection to the terminal

export type EditorMenuIconKey = 'copy' | 'search' | 'graph' | 'command' | 'doc' | 'mention';

export interface EditorMenuItemSpec {
  /** Stable id for tests and React keys. */
  id: string;
  label: string;
  action: EditorMenuAction;
  iconKey?: EditorMenuIconKey;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/**
 * Build the ordered context-menu item specs for the given editor context.
 * Deterministic: same context in → same list out.
 */
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

  // Navigation — the custom worker-backed go-to-definition (NOT Monaco built-in).
  items.push({
    id: 'goToDefinition',
    label: 'Go to Definition',
    action: { kind: 'action', actionId: 'agentdeck.goToDefinition' },
    iconKey: 'graph',
    disabled: !ctx.canGoToDefinition,
    separatorBefore: true,
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

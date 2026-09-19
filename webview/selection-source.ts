/**
 * Where the user's current selection lives, for seeding global search (Mod+Shift+F) the way
 * VS Code does. Pure: the caller hands in the focus/selection facts. Precedence mirrors the
 * shortcut dispatcher's (decide-shortcut.ts, app.tsx): terminal, then editor, then the DOM.
 */

import { isEditorEntry, isTerminalEntry } from './typing-guard';

export type SelectionSource = 'terminal' | 'editor' | 'dom' | 'none';

export interface SelectionContext {
  activeEl: Element | null;
  domAnchor: Node | null;
  /** Focus — or a stray text selection — inside the Explorer panel. */
  explorerHasFocus: boolean;
}

export function selectionSourceFor(ctx: SelectionContext): SelectionSource {
  if (isTerminalEntry(ctx.activeEl)) return 'terminal';
  if (isEditorEntry(ctx.activeEl)) return 'editor';
  // The Explorer is an explicit non-participant: its "selection" is selected FILES
  // (file-tree-selection.ts), and `.filerow` text is selectable, so a stray text selection
  // there is possible. content-search matches filenames too, so seeding from one would
  // return a plausible-looking result and hide the mistake.
  if (ctx.explorerHasFocus) return 'none';
  // Selecting text in rendered Markdown or in Review leaves document.activeElement on
  // <body>, so only the live selection anchor finds it (same insight as markdown-viewer's
  // Ctrl+A owns-check).
  if (ctx.domAnchor) return 'dom';
  return 'none';
}

/**
 * Pure builder for the rendered-markdown view's right-click context menu.
 *
 * Mirrors term-menu.ts / editor-menu.ts: decides WHICH items appear and their
 * enabled state purely from context, with no React/DOM dependency, so it's
 * deterministic and unit-testable. The rendered view is read-only, so the menu
 * offers Copy (of the current selection) and Select All — no paste/cut.
 */

export interface MarkdownMenuContext {
  /** A non-empty text selection exists in the rendered view — gates Copy. */
  hasSelection: boolean;
}

export type MarkdownMenuAction = 'copy' | 'selectAll';

export interface MarkdownMenuItemSpec {
  id: string;
  label: string;
  action: MarkdownMenuAction;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/** Build the ordered markdown context-menu specs. Deterministic. */
export function buildMarkdownMenuItems(ctx: MarkdownMenuContext): MarkdownMenuItemSpec[] {
  return [
    { id: 'copy', label: 'Copy', action: 'copy', disabled: !ctx.hasSelection },
    { id: 'selectAll', label: 'Select All', action: 'selectAll', separatorBefore: true },
  ];
}

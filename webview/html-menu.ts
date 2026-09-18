/**
 * Pure builder for the HTML preview guest's right-click context menu.
 *
 * Mirrors markdown-menu.ts / term-menu.ts: decides WHICH items appear and their enabled
 * state purely from context, with no React/DOM dependency. The guest page is read-only,
 * so the menu offers Copy and Select all — no paste/cut.
 */

export interface HtmlMenuContext {
  /** A non-empty text selection exists in the guest page — gates Copy. */
  hasSelection: boolean;
  /** The link enclosing the right-clicked node, when there is one. */
  linkURL?: string;
}

export type HtmlMenuAction =
  | 'copy'
  | 'selectAll'
  | 'copyLink'
  | 'openLink'
  | 'find'
  | 'reload'
  | 'viewSource';

export interface HtmlMenuItemSpec {
  id: string;
  label: string;
  action: HtmlMenuAction;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function buildHtmlMenuItems(ctx: HtmlMenuContext): HtmlMenuItemSpec[] {
  const items: HtmlMenuItemSpec[] = [
    { id: 'copy', label: 'Copy', action: 'copy', disabled: !ctx.hasSelection },
    { id: 'selectAll', label: 'Select all', action: 'selectAll' },
  ];
  if (ctx.linkURL) {
    items.push(
      {
        id: 'copyLink',
        label: 'Copy link address',
        action: 'copyLink',
        separatorBefore: true,
      },
      { id: 'openLink', label: 'Open link externally', action: 'openLink' },
    );
  }
  items.push(
    { id: 'find', label: 'Find…', action: 'find', separatorBefore: true },
    { id: 'reload', label: 'Reload', action: 'reload', separatorBefore: true },
    { id: 'viewSource', label: 'View source', action: 'viewSource' },
  );
  return items;
}

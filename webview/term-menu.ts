/**
 * Pure builder for the terminal's right-click context-menu item list (L4):
 * decides WHICH items appear and their enabled state from the terminal context.
 *
 * Design notes (see docs/specs/archive/2026-06-11-terminal-ergonomics.md):
 * - Copy is shown but disabled with no selection (discoverable). Enablement is
 *   snapshotted at menu-open, before any right-click selection mutation, so it
 *   reflects the selection the user sees.
 * - Paste is disabled when the clipboard read API is unavailable (browser preview
 *   / no permission); when enabled, a failed read surfaces an error toast.
 */

export interface TerminalMenuContext {
  /** A non-empty terminal selection exists — gates Copy's enabled state. */
  hasSelection: boolean;
  /** The clipboard read API is available — gates Paste's enabled state. */
  canPaste: boolean;
}

/** Stable action kind for each terminal menu item (the component dispatches on this). */
export type TerminalMenuAction = 'copy' | 'paste' | 'clear' | 'find';

export type TerminalMenuIconKey = 'copy' | 'paste' | 'clear' | 'search';

export interface TerminalMenuItemSpec {
  /** Stable id for tests and React keys. */
  id: string;
  label: string;
  action: TerminalMenuAction;
  iconKey: TerminalMenuIconKey;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/**
 * Build the ordered terminal context-menu item specs for the given context.
 * Deterministic: same context in → same list out.
 */
export function buildTerminalMenuItems(ctx: TerminalMenuContext): TerminalMenuItemSpec[] {
  return [
    {
      id: 'copy',
      label: 'Copy',
      action: 'copy',
      iconKey: 'copy',
      disabled: !ctx.hasSelection,
    },
    {
      id: 'paste',
      label: 'Paste',
      action: 'paste',
      iconKey: 'paste',
      disabled: !ctx.canPaste,
    },
    {
      id: 'find',
      label: 'Find',
      action: 'find',
      iconKey: 'search',
      separatorBefore: true,
    },
    {
      id: 'clear',
      label: 'Clear',
      action: 'clear',
      iconKey: 'clear',
    },
  ];
}

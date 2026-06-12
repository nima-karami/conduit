/**
 * Pure builder for the terminal's right-click context-menu item list (L4).
 *
 * Mirrors `editor-menu.ts`: this module decides WHICH items appear and their
 * enabled state purely from the terminal context, with no React/xterm dependency
 * — so it's deterministic and unit-testable in node. `terminal-pane.tsx` maps each
 * spec to a shared `MenuItem` (binding the real xterm action + an icon).
 *
 * Design notes (see docs/specs/archive/2026-06-11-terminal-ergonomics.md):
 * - Copy is present but disabled with no selection (discoverable; can't act on
 *   nothing). Enablement is snapshotted at menu-open so it reflects the selection
 *   the user sees, before any right-click selection mutation.
 * - Paste is disabled when the clipboard read API is unavailable (browser preview
 *   / no permission). When enabled, a failed read surfaces an error toast rather
 *   than silently doing nothing.
 * - Clear and Find are always available (Find opens the find bar; Clear runs
 *   `term.clear()`).
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

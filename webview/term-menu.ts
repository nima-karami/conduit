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

import { TERM_LINK_STR } from './term-link-strings';

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

/** Link actions a terminal path link adds to the menu (spec 2026-10-16-terminal-path-links §3.4). */
export type LinkMenuAction =
  | 'open'
  | 'showAll'
  | 'copyPath'
  | 'copyRelativePath'
  | 'reveal'
  | 'openAsSession';

export interface LinkMenuContext {
  /** null = ambiguous (chooseClickAction → pick): every action goes through the picker. */
  target: 'file' | 'dir' | null;
  /** All matches (the resolution's total). */
  matchCount: number;
  /** "in <project>". */
  openAsSessionHint?: string;
}

export interface LinkMenuItemSpec {
  id: LinkMenuAction;
  label: string;
  hint?: string;
  separatorBefore?: boolean;
}

/** Primary (open / show all) → reference (copy, reveal) → session; the terminal's own items
 *  follow. */
export function buildLinkMenuItems(ctx: LinkMenuContext): LinkMenuItemSpec[] {
  const ambiguous = ctx.target === null;
  const countHint = ambiguous ? { hint: TERM_LINK_STR.matches(ctx.matchCount) } : {};
  const primary: LinkMenuItemSpec[] = [];
  if (ctx.target === 'file') primary.push({ id: 'open', label: TERM_LINK_STR.open });
  if (ambiguous || ctx.matchCount > 1)
    primary.push({ id: 'showAll', label: TERM_LINK_STR.showAll });
  const reference: LinkMenuItemSpec[] = [
    {
      id: 'copyPath',
      label: TERM_LINK_STR.copyPath,
      ...countHint,
      ...(primary.length > 0 ? { separatorBefore: true } : {}),
    },
    { id: 'copyRelativePath', label: TERM_LINK_STR.copyRelativePath, ...countHint },
    { id: 'reveal', label: TERM_LINK_STR.reveal, ...countHint },
  ];
  const sessionHint = ambiguous
    ? countHint
    : ctx.openAsSessionHint
      ? { hint: ctx.openAsSessionHint }
      : {};
  return [
    ...primary,
    ...reference,
    {
      id: 'openAsSession',
      label: TERM_LINK_STR.openAsSession,
      separatorBefore: true,
      ...sessionHint,
    },
  ];
}

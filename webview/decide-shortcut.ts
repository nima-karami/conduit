// Pure precedence decision for the app shortcut dispatcher — app shortcuts are a fallback
// behind the terminal and editor. See docs/specs/2026-07-03-shortcut-precedence-and-editable-nav.md §1.

import { isComboAllowedWhileTyping } from './typing-guard';

export interface ShortcutContext {
  inTerminal: boolean;
  // Part of the context for completeness; the editor-consumed case is handled by
  // defaultPrevented (Monaco marks keys it binds), so no rule branches on inEditor.
  inEditor: boolean;
  inFormField: boolean;
  defaultPrevented: boolean;
  combo: string;
}

/** Whether an app shortcut action should fire given the current focus context. */
export function decideShortcut(ctx: ShortcutContext, actionId: string): boolean {
  if (ctx.inTerminal) return actionId === 'navFocusTerminal';
  if (ctx.defaultPrevented) return false;
  if (ctx.inFormField) return isComboAllowedWhileTyping(ctx.combo);
  return true;
}

/**
 * Typing-entry guard for global keyboard shortcuts.
 *
 * Rule: most global shortcuts (palette, sidebar, nav) MUST NOT fire when
 * the user is typing in a text-entry element (input, textarea, contenteditable).
 * Exception: Mod+S (save) IS allowed everywhere — it is intentionally global.
 *
 * "Monaco handles its own" — Monaco's editor has focus only when the user is
 * actively in the code editor. When Monaco has focus, this guard is irrelevant
 * because Monaco stops the event before it bubbles to window (it handles
 * Ctrl+S itself via its own onKeyDown). So the guard only needs to cover
 * non-Monaco text fields (session filter input, spec textarea, pipeline inputs).
 */

/** Returns true if the element is a user-text-entry surface. */
export function isTypingEntry(el: Element | null): boolean {
  if (!el) return false;
  // xterm's hidden input proxy (`.xterm-helper-textarea`) is a TEXTAREA, but it's a
  // TERMINAL surface, not a form field — global app shortcuts (find-in-files, palette,
  // sidebar toggles) MUST pass through it just like they do over the editor, matching
  // VS Code's integrated terminal. Treating it as a typing-entry would make those
  // shortcuts dead whenever a session is focused (which is most of the time).
  if (el.classList?.contains('xterm-helper-textarea')) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Returns true if the combo is allowed to fire even while the user is typing
 * in a text-entry element.
 *
 * Allowed while typing:
 *   - Mod+S   (save — intentionally global, same save Monaco handles)
 *   - Escape  (handled per-component via useEscapeKey, not the global handler)
 *
 * Everything else is blocked so typing in a filter/input doesn't accidentally
 * open the palette, toggle the sidebar, open settings, etc.
 */
export function isComboAllowedWhileTyping(combo: string): boolean {
  return combo === 'Mod+S' || combo.startsWith('Escape');
}

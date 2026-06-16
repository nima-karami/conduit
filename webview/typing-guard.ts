/**
 * Typing-entry guard for global keyboard shortcuts.
 *
 * Rule: most global shortcuts (palette, sidebar, nav) MUST NOT fire when
 * the user is typing in a text-entry element (input, textarea, contenteditable).
 * Exception: Mod+S (save) IS allowed everywhere — it is intentionally global.
 *
 * Monaco surfaces: Monaco uses a `.native-edit-context` div (role=textbox,
 * aria-roledescription=editor) as its key-input target in modern Chromium. That
 * element is neither INPUT/TEXTAREA nor contentEditable, so a simple tag check
 * misses it. The explicit `.closest('.monaco-editor')` walk below catches it — any
 * focused element INSIDE a `.monaco-editor` container is treated as a typing entry
 * so that Ctrl+Z defers to Monaco's own undo rather than the global fs-undo stack.
 *
 * xterm surfaces: xterm's `.xterm-helper-textarea` IS a TEXTAREA, but is a
 * TERMINAL surface — global shortcuts (palette, sidebar toggles) must pass through
 * it, matching VS Code's terminal behaviour. It is explicitly excluded so those
 * shortcuts remain reachable while a session is focused.
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
  // Monaco uses `.native-edit-context` (a non-editable DIV with role=textbox and
  // aria-roledescription=editor) as its focused key-sink in modern Chromium. It is
  // not contentEditable and not an INPUT/TEXTAREA, so the checks above miss it.
  // Any focused element inside `.monaco-editor` is a Monaco editing surface — treat
  // it as a typing entry so Ctrl+Z defers to Monaco's own model-level undo.
  if (el.closest?.('.monaco-editor')) return true;
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

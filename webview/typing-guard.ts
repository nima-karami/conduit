/**
 * Typing-entry guard: most global shortcuts (palette, sidebar, nav) MUST NOT fire while
 * the user types in a text-entry element; Mod+S is the deliberate exception. The Monaco
 * and xterm surfaces below need special handling (see inline notes).
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
 * Whether a combo may fire while typing. Only Mod+S (intentionally global) and Escape
 * (handled per-component via useEscapeKey) are allowed; everything else is blocked so
 * typing in an input doesn't accidentally trigger app shortcuts.
 */
export function isComboAllowedWhileTyping(combo: string): boolean {
  return combo === 'Mod+S' || combo.startsWith('Escape');
}

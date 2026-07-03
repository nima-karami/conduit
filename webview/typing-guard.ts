/**
 * Typing-entry guard: most global shortcuts (palette, sidebar, nav) MUST NOT fire while
 * the user types in a text-entry element; Mod+S is the deliberate exception. The Monaco
 * and xterm surfaces below need special handling (see inline notes).
 */

/** True when focus is in the xterm surface (its hidden helper textarea). */
export function isTerminalEntry(el: Element | null): boolean {
  return !!el?.classList?.contains('xterm-helper-textarea');
}

/** Returns true if the element is a user-text-entry surface. */
export function isTypingEntry(el: Element | null): boolean {
  if (!el) return false;
  // xterm's hidden input proxy (`.xterm-helper-textarea`) is a TEXTAREA, but it's a
  // TERMINAL surface, not a form field. Terminal precedence is enforced by the capture/
  // bubble split in app.tsx (isTerminalEntry), not here — this guard only concerns real
  // form inputs, so the terminal must not read as one.
  if (isTerminalEntry(el)) return false;
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

/** True when focus is inside a Monaco editor surface. */
export function isEditorEntry(el: Element | null): boolean {
  return !!el?.closest?.('.monaco-editor');
}

/**
 * Whether a combo may fire while typing in a form field. Only Mod+S (intentionally global)
 * and Escape (handled per-component via useEscapeKey) are allowed; everything else is
 * blocked so typing in an input doesn't accidentally trigger app shortcuts.
 */
export function isComboAllowedWhileTyping(combo: string): boolean {
  return combo === 'Mod+S' || combo.startsWith('Escape');
}

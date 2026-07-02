// Lets a global shortcut (Ctrl+`) and a session switch hand focus to a specific session's
// terminal. The TerminalPane owns the xterm instance, so it subscribes and calls its own
// focus — the requester doesn't reach into xterm internals or guess the live DOM node.

import { isTypingEntry } from './typing-guard';

type Listener = (sessionId: string) => void;

const subs = new Set<Listener>();

export function subscribeTerminalFocus(cb: Listener): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function requestTerminalFocus(sessionId: string): void {
  for (const cb of subs) cb(sessionId);
}

/**
 * Whether switching to a session should pull keyboard focus into its terminal. Only when the
 * Terminal — not a doc/editor/web tab — is that session's visible view (its doc `activeId` is
 * `null`), and never while focus sits in a real form field the user is typing in (switching
 * sessions from, e.g., the search box must not yank focus out of it). See the active-session
 * focus effect in app.tsx.
 */
export function shouldFocusActiveTerminal(
  docActiveId: string | null,
  focusedEl: Element | null,
): boolean {
  return docActiveId === null && !isTypingEntry(focusedEl);
}

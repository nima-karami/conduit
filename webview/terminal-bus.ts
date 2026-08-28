// The one channel between the rest of the renderer and a session's live xterm. Widened from the
// old focus-only fan-out (terminal-focus-bus.ts) into a sessionId-keyed REGISTRY, because Lane F's
// handoff has to ask a question a fan-out cannot answer — "does this session have a live terminal
// right now?" — and has to deliver text to that one terminal (spec 2026-08-27-review-supercharge
// §2 Lane F).
//
// Paste goes through xterm's own paste(). That wraps the text in [200~ ... [201~ ONLY when
// the foreground program has turned bracketed paste on (DECSET 2004) — it is not a property of
// paste() itself. Without it every newline in a multi-line handoff is a carriage return, and a
// session sitting at a bare shell prompt would EXECUTE each line of the reviewer's notes. So the
// mode is a precondition here, not an assumption: a terminal that does not report it is treated as
// having no terminal at all, and the caller falls back to the clipboard. Raw `term:input` (what
// mention-bus.ts uses for a short reference) bypasses bracketing entirely and is never used.

import { isTypingEntry } from './typing-guard';

export interface TerminalApi {
  focus(): void;
  /** xterm's paste(). Only safe for multi-line text while `bracketedPaste()` is true. */
  paste(text: string): void;
  /** Live read of xterm's `modes.bracketedPasteMode` — the foreground program owns it, so it
   *  changes as the user moves between an agent TUI and a bare shell prompt. */
  bracketedPaste(): boolean;
}

const terminals = new Map<string, TerminalApi>();

// Anything that RENDERS from `hasLiveTerminal` has to re-render when the registry changes, and a
// terminal registering is not a React state update. One version counter, read through
// useSyncExternalStore, is what keeps the handoff control's label from going stale.
let version = 0;
const busListeners = new Set<() => void>();

function bump(): void {
  version += 1;
  busListeners.forEach((l) => {
    l();
  });
}

/** Tell readers something they render from has changed — today, a session's bracketed-paste
 *  mode, which xterm only reveals through the escape sequences its program writes. */
export function notifyTerminalBus(): void {
  bump();
}

export function subscribeTerminalBus(cb: () => void): () => void {
  busListeners.add(cb);
  return () => {
    busListeners.delete(cb);
  };
}

export function getTerminalBusVersion(): number {
  return version;
}

/**
 * Register a session's live terminal. Returns the unregister. The unregister is IDENTITY-CHECKED:
 * React can mount a replacement before it runs the old instance's cleanup, and a blind delete
 * would then evict the terminal that is actually on screen.
 */
export function registerTerminal(sessionId: string, api: TerminalApi): () => void {
  terminals.set(sessionId, api);
  bump();
  return () => {
    if (terminals.get(sessionId) !== api) return;
    terminals.delete(sessionId);
    bump();
  };
}

/**
 * Whether a multi-line paste can safely reach this session: a registered terminal whose foreground
 * program has bracketed paste ON. A live terminal at a bare `cmd.exe` prompt answers FALSE — the
 * text would be executed line by line.
 */
export function hasLiveTerminal(sessionId: string): boolean {
  return terminals.get(sessionId)?.bracketedPaste() === true;
}

/** Hand focus to a session's terminal. Name unchanged from the focus bus — see the callers. */
export function requestTerminalFocus(sessionId: string): void {
  terminals.get(sessionId)?.focus();
}

interface PasteSpy {
  __conduitPasteSpy?: Array<{ sessionId: string; text: string }>;
}

/** Deliver text to a session's terminal. False when it has none (the caller offers a fallback). */
export function pasteToTerminal(sessionId: string, text: string): boolean {
  const api = terminals.get(sessionId);
  // Re-checked at delivery, not just at render: the user can drop out of the agent TUI between
  // the button rendering and the click.
  if (!api || !api.bracketedPaste()) return false;
  api.paste(text);

  // Test observability (opt-in), mirroring window.__terms in terminal-pane.tsx: a harness that
  // pre-creates the array gets every DELIVERY; nothing creates it in production, so this is inert.
  // Recorded after the guards so a refused attempt is never logged as a delivery.
  const spy = (window as unknown as PasteSpy).__conduitPasteSpy;
  if (spy) spy.push({ sessionId, text });
  return true;
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

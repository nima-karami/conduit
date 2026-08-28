// The one channel between the rest of the renderer and a session's live xterm. Widened from the
// old focus-only fan-out (terminal-focus-bus.ts) into a sessionId-keyed REGISTRY, because Lane F's
// handoff has to ask a question a fan-out cannot answer — "does this session have a live terminal
// right now?" — and has to deliver text to that one terminal (spec 2026-08-27-review-supercharge
// §2 Lane F).
//
// Paste goes through xterm's own paste(), which honours bracketed-paste mode: a multi-line handoff
// reaches a TUI as ONE atomic paste rather than N lines each acting like Enter. Raw `term:input`
// (what mention-bus.ts uses for a short reference) would bypass that and is deliberately not used.

import { isTypingEntry } from './typing-guard';

export interface TerminalApi {
  focus(): void;
  /** xterm's paste(): bracketed, atomic, never followed by Enter. */
  paste(text: string): void;
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

export function hasLiveTerminal(sessionId: string): boolean {
  return terminals.has(sessionId);
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
  // Test observability (opt-in), mirroring window.__terms in terminal-pane.tsx: a harness that
  // pre-creates the array gets every delivery; nothing creates it in production, so this is inert.
  const spy = (window as unknown as PasteSpy).__conduitPasteSpy;
  if (spy) spy.push({ sessionId, text });

  const api = terminals.get(sessionId);
  if (!api) return false;
  api.paste(text);
  return true;
}

// Companion to the paste spy, gated on it: the smoke suite needs to drive the "no live terminal"
// branch of the handoff, and there is no other way to make a mounted pane stop being live. The
// harness creates the spy before the app's first render, so this is false in production.
if ((window as unknown as PasteSpy).__conduitPasteSpy) {
  (window as unknown as { __conduitTerminalBus?: unknown }).__conduitTerminalBus = {
    unregister: (sessionId: string) => {
      if (!terminals.delete(sessionId)) return;
      bump();
    },
  };
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

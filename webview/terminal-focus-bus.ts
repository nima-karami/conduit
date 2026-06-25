// Lets a global shortcut (Ctrl+`) hand focus to a specific session's terminal. The
// TerminalPane owns the xterm instance, so it subscribes and calls its own focus —
// the requester doesn't reach into xterm internals or guess the live DOM node.

type Listener = (sessionId: string) => void;

const subs = new Set<Listener>();

export function subscribeTerminalFocus(cb: Listener): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function requestTerminalFocus(sessionId: string): void {
  for (const cb of subs) cb(sessionId);
}

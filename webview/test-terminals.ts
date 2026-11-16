// Opt-in test observability: when a harness has pre-created window.__terms, a pane exposes its live
// xterm there so e2e can assert on the rendered buffer, not just the bytes sent (see TerminalPane).
// Production never creates the object, so these are no-ops there.

import type { Terminal } from '@xterm/xterm';

declare global {
  interface Window {
    __terms?: Record<string, Terminal>;
  }
}

export function exposeTerminal(id: string, term: Terminal): void {
  if (window.__terms) window.__terms[id] = term;
}

export function unexposeTerminal(id: string, term: Terminal): void {
  if (window.__terms?.[id] === term) delete window.__terms[id];
}

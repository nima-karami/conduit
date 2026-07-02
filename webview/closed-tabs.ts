// Bounded stack of recently-closed doc tabs, powering "reopen closed tab" (Mod+Shift+T).
// Only kinds that round-trip cleanly from (kind, path, sessionId) are tracked — see
// isReopenable — so a pop always reopens to the same content without extra state.

import type { DocKind, OpenDoc } from './docs';

export const CLOSED_TAB_LIMIT = 10;

// review/git-history are singletons with their own entry points, and commit-diff needs a
// sha+file+pin the descriptor doesn't carry. file/diff/web reopen straight from their path.
export type ReopenableKind = Extract<DocKind, 'file' | 'diff' | 'web'>;

export interface ClosedTab {
  kind: ReopenableKind;
  path: string;
  sessionId: string;
}

export function isReopenable(doc: Pick<OpenDoc, 'kind'>): boolean {
  return doc.kind === 'file' || doc.kind === 'diff' || doc.kind === 'web';
}

export function toClosedTab(doc: Pick<OpenDoc, 'kind' | 'path' | 'sessionId'>): ClosedTab | null {
  if (!isReopenable(doc)) return null;
  return { kind: doc.kind as ReopenableKind, path: doc.path, sessionId: doc.sessionId };
}

/** Push a closed tab, evicting the oldest once the cap is exceeded. */
export function pushClosedTab(stack: ClosedTab[], tab: ClosedTab): ClosedTab[] {
  const next = [...stack, tab];
  return next.length > CLOSED_TAB_LIMIT ? next.slice(next.length - CLOSED_TAB_LIMIT) : next;
}

/** Pop the most recently closed tab (LIFO). */
export function popClosedTab(stack: ClosedTab[]): { tab: ClosedTab | null; rest: ClosedTab[] } {
  if (stack.length === 0) return { tab: null, rest: stack };
  return { tab: stack[stack.length - 1], rest: stack.slice(0, -1) };
}

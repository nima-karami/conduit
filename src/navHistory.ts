// Browser-style navigation history for the center "view". A location identifies
// which session's terminal or which document tab is showing. Pure + unit-tested;
// the React glue lives in webview/useNavHistory.ts.

export interface NavLoc {
  sessionId?: string;
  docId: string | null; // null = the session's terminal tab
}

export interface NavState {
  stack: NavLoc[];
  index: number;
}

export const EMPTY_NAV: NavState = { stack: [], index: -1 };

function sameLoc(a: NavLoc | undefined, b: NavLoc | undefined): boolean {
  if (!a || !b) return false;
  return a.sessionId === b.sessionId && a.docId === b.docId;
}

export function current(state: NavState): NavLoc | undefined {
  return state.stack[state.index];
}

/** Record a new location: no-op if it equals the current; otherwise truncate any
 *  forward history and append. */
export function record(state: NavState, loc: NavLoc): NavState {
  if (sameLoc(current(state), loc)) return state;
  const stack = state.stack.slice(0, state.index + 1);
  stack.push(loc);
  return { stack, index: stack.length - 1 };
}

export const canBack = (s: NavState): boolean => s.index > 0;
export const canForward = (s: NavState): boolean => s.index < s.stack.length - 1;

export function back(s: NavState): NavState {
  return canBack(s) ? { ...s, index: s.index - 1 } : s;
}

export function forward(s: NavState): NavState {
  return canForward(s) ? { ...s, index: s.index + 1 } : s;
}

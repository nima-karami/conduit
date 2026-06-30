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

/** Whether a recorded location still resolves to a live session/doc. Injected into
 *  traversal so Back/Forward skip entries whose doc or session was closed. */
export type IsAlive = (loc: NavLoc) => boolean;

/** Max retained locations. Older ones are evicted from the front on overflow so the
 *  per-window stack stays bounded (spec §3.1b / D6). */
export const NAV_STACK_CAP = 50;

function sameLoc(a: NavLoc | undefined, b: NavLoc | undefined): boolean {
  if (!a || !b) return false;
  return a.sessionId === b.sessionId && a.docId === b.docId;
}

export function current(state: NavState): NavLoc | undefined {
  return state.stack[state.index];
}

/** Record a new location: no-op if it equals the current; otherwise truncate any
 *  forward history and append. Drops the oldest entries past NAV_STACK_CAP. */
export function record(state: NavState, loc: NavLoc): NavState {
  if (sameLoc(current(state), loc)) return state;
  const stack = state.stack.slice(0, state.index + 1);
  stack.push(loc);
  if (stack.length > NAV_STACK_CAP) {
    const drop = stack.length - NAV_STACK_CAP;
    return { stack: stack.slice(drop), index: stack.length - drop - 1 };
  }
  return { stack, index: stack.length - 1 };
}

export const canBack = (s: NavState): boolean => s.index > 0;
export const canForward = (s: NavState): boolean => s.index < s.stack.length - 1;

/** Step the index in `dir` (-1 back / +1 forward), skipping entries `isAlive` rejects
 *  and landing on the nearest live one. If none is live in that direction, return the
 *  state unchanged (no-op). Dead entries stay in the stack — they're only skipped. */
function step(s: NavState, dir: -1 | 1, isAlive?: IsAlive): NavState {
  for (let i = s.index + dir; i >= 0 && i < s.stack.length; i += dir) {
    if (!isAlive || isAlive(s.stack[i])) return { ...s, index: i };
  }
  return s;
}

export function back(s: NavState, isAlive?: IsAlive): NavState {
  return step(s, -1, isAlive);
}

export function forward(s: NavState, isAlive?: IsAlive): NavState {
  return step(s, 1, isAlive);
}

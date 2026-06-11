/**
 * Pure state machine for the terminal find bar (L4 — terminal ergonomics).
 *
 * The find bar overlay (`term-search-bar.tsx`) is a thin shell that binds this
 * reducer to xterm's `SearchAddon` (`findNext` / `findPrevious`). Keeping the
 * open/close/query/navigation logic here makes it deterministic and unit-testable
 * in node with no DOM or xterm dependency.
 *
 * The reducer owns only UI state (is the bar open, the current query, the last
 * navigation direction). It does NOT own match results — xterm's addon decorates
 * matches itself and the component asks it to move; there is no count to track
 * (the 0.15 addon's result-count callback is optional and not surfaced here).
 */

export interface TermSearchState {
  /** Is the find bar visible. Closed = no query work happens. */
  open: boolean;
  /** Current search query (preserved while the bar stays open). */
  query: string;
  /** Last navigation the user asked for — drives which addon call the shell makes. */
  direction: 'next' | 'prev';
}

export type TermSearchAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'setQuery'; query: string }
  | { type: 'next' }
  | { type: 'prev' };

export const initialTermSearchState: TermSearchState = {
  open: false,
  query: '',
  direction: 'next',
};

/**
 * Advance the find-bar state. Pure: same (state, action) → same next state.
 *
 * - `open` shows the bar but PRESERVES any existing query (re-opening keeps your
 *   last search so Mod+F twice doesn't wipe it).
 * - `close` hides the bar and resets the query to empty (a fresh open starts clean
 *   once the bar has been dismissed — distinct from re-opening without closing).
 * - `setQuery` updates the query and resets direction to `next` (typing restarts a
 *   forward search from the top, matching find-bar convention).
 * - `next` / `prev` only set the direction; the shell reads it to call the addon.
 *   They are no-ops on an empty query (nothing to navigate).
 */
export function termSearchReducer(
  state: TermSearchState,
  action: TermSearchAction,
): TermSearchState {
  switch (action.type) {
    case 'open':
      return { ...state, open: true };
    case 'close':
      return { ...initialTermSearchState };
    case 'setQuery':
      return { ...state, query: action.query, direction: 'next' };
    case 'next':
      if (!state.query) return state;
      return { ...state, direction: 'next' };
    case 'prev':
      if (!state.query) return state;
      return { ...state, direction: 'prev' };
    default:
      return state;
  }
}

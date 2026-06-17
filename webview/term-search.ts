/**
 * Pure state machine for the terminal find bar (L4 — terminal ergonomics).
 *
 * Owns only UI state (open, query, last nav direction); the overlay
 * (`term-search-bar.tsx`) binds it to xterm's `SearchAddon`. Match results live
 * in the addon, not here — there is no count to track.
 */

export interface TermSearchState {
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
 * Advance the find-bar state.
 *
 * - `open` PRESERVES any existing query (re-opening keeps your last search).
 * - `close` resets the query (a fresh open after dismissal starts clean).
 * - `setQuery` resets direction to `next` (typing restarts a forward search).
 * - `next` / `prev` set direction only, and are no-ops on an empty query.
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

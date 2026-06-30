import { useCallback, useEffect, useRef, useState } from 'react';
import {
  back,
  canBack,
  canForward,
  current,
  EMPTY_NAV,
  forward,
  type IsAlive,
  type NavLoc,
  record,
} from '../src/nav-history';

/**
 * Browser-style Back/Forward for the center view. Records the current
 * {sessionId, docId} as the user navigates; goBack/goForward replay history
 * without recording and call `apply` with the target location. `isAlive` lets
 * traversal skip entries whose doc/session has since closed (spec §3.1a).
 */
export function useNavHistory(loc: NavLoc, apply: (loc: NavLoc) => void, isAlive?: IsAlive) {
  const [state, setState] = useState(EMPTY_NAV);
  const navigating = useRef(false);

  // Skip navigations we just applied via back/forward; record only real ones.
  useEffect(() => {
    if (navigating.current) {
      navigating.current = false;
      return;
    }
    // Ignore the transient pre-session location (no active session yet, on first
    // mount before sessions load). Recording it would seed a phantom history entry
    // so Back lights up at launch with nothing real to go back to (R5.2).
    if (loc.sessionId === undefined) return;
    setState((s) => record(s, loc));
  }, [loc.sessionId, loc.docId, loc]);

  const goBack = useCallback(() => {
    setState((s) => {
      const next = back(s, isAlive);
      if (next === s) return s;
      navigating.current = true;
      const target = current(next);
      if (target) apply(target);
      return next;
    });
  }, [apply, isAlive]);

  const goForward = useCallback(() => {
    setState((s) => {
      const next = forward(s, isAlive);
      if (next === s) return s;
      navigating.current = true;
      const target = current(next);
      if (target) apply(target);
      return next;
    });
  }, [apply, isAlive]);

  return { goBack, goForward, canBack: canBack(state), canForward: canForward(state) };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_NAV, NavLoc, record, back, forward, canBack, canForward, current,
} from '../src/navHistory';

/**
 * Browser-style Back/Forward for the center view. Records the current
 * {sessionId, docId} as the user navigates; goBack/goForward replay history
 * without recording and call `apply` with the target location.
 */
export function useNavHistory(loc: NavLoc, apply: (loc: NavLoc) => void) {
  const [state, setState] = useState(EMPTY_NAV);
  const navigating = useRef(false);

  // Record real navigations (skip the ones we just applied via back/forward).
  useEffect(() => {
    if (navigating.current) { navigating.current = false; return; }
    setState((s) => record(s, loc));
  }, [loc.sessionId, loc.docId]);

  const goBack = useCallback(() => {
    setState((s) => {
      if (!canBack(s)) return s;
      const next = back(s);
      navigating.current = true;
      const target = current(next);
      if (target) apply(target);
      return next;
    });
  }, [apply]);

  const goForward = useCallback(() => {
    setState((s) => {
      if (!canForward(s)) return s;
      const next = forward(s);
      navigating.current = true;
      const target = current(next);
      if (target) apply(target);
      return next;
    });
  }, [apply]);

  return { goBack, goForward, canBack: canBack(state), canForward: canForward(state) };
}

import { useCallback, useEffect, useRef } from 'react';
import {
  INITIAL_REVIEW_LAYOUT,
  type ReviewLayoutState,
  reduceReviewLayout,
} from '../src/review-mode-layout';

/** Auto-open / restore of the right pane around review mode — spec 2026-09-05-review-mode §2.1. */
export function useReviewModeLayout(input: {
  reviewMode: boolean;
  reviewDocOpen: boolean;
  explorerCollapsed: boolean;
  setExplorerCollapsed: (v: boolean) => void;
  showChanges: () => void;
}): { userToggledExplorer: () => void } {
  const { reviewMode, reviewDocOpen, setExplorerCollapsed, showChanges } = input;
  const state = useRef<ReviewLayoutState>(INITIAL_REVIEW_LAYOUT);
  const explorerCollapsedRef = useRef(input.explorerCollapsed);
  explorerCollapsedRef.current = input.explorerCollapsed;

  const apply = useCallback(
    (effect: ReturnType<typeof reduceReviewLayout>['effect']) => {
      if (effect.setExplorerCollapsed !== undefined) {
        setExplorerCollapsed(effect.setExplorerCollapsed);
      }
      if (effect.showChanges) showChanges();
    },
    [setExplorerCollapsed, showChanges],
  );

  useEffect(() => {
    const { state: next, effect } = reduceReviewLayout(state.current, {
      type: 'mode',
      on: reviewMode,
      explorerCollapsed: explorerCollapsedRef.current,
    });
    state.current = next;
    apply(effect);
  }, [reviewMode, apply]);

  const prevDocOpenRef = useRef(reviewDocOpen);
  useEffect(() => {
    const was = prevDocOpenRef.current;
    prevDocOpenRef.current = reviewDocOpen;
    if (!(was && !reviewDocOpen)) return;
    const { state: next, effect } = reduceReviewLayout(state.current, {
      type: 'reviewDocClosed',
      explorerCollapsed: explorerCollapsedRef.current,
    });
    state.current = next;
    apply(effect);
  }, [reviewDocOpen, apply]);

  const userToggledExplorer = useCallback(() => {
    state.current = reduceReviewLayout(state.current, { type: 'userToggledExplorer' }).state;
  }, []);

  return { userToggledExplorer };
}

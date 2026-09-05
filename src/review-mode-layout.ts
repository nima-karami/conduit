// spec docs/specs/2026-09-05-review-mode.md §2.1, §3

export interface ReviewLayoutState {
  autoOpened: boolean;
}

export const INITIAL_REVIEW_LAYOUT: ReviewLayoutState = { autoOpened: false };

export type ReviewLayoutEvent =
  | { type: 'mode'; on: boolean; explorerCollapsed: boolean }
  | { type: 'userToggledExplorer' }
  | { type: 'reviewDocClosed'; explorerCollapsed: boolean };

export interface ReviewLayoutEffect {
  setExplorerCollapsed?: boolean;
  showChanges?: true;
}

export function reduceReviewLayout(
  state: ReviewLayoutState,
  ev: ReviewLayoutEvent,
): { state: ReviewLayoutState; effect: ReviewLayoutEffect } {
  switch (ev.type) {
    case 'mode': {
      if (!ev.on) return { state, effect: {} };
      if (!ev.explorerCollapsed) return { state, effect: { showChanges: true } };
      return {
        state: { autoOpened: true },
        effect: { setExplorerCollapsed: false, showChanges: true },
      };
    }
    case 'userToggledExplorer':
      return { state: { autoOpened: false }, effect: {} };
    case 'reviewDocClosed': {
      const restore = state.autoOpened && !ev.explorerCollapsed;
      return {
        state: { autoOpened: false },
        effect: restore ? { setExplorerCollapsed: true } : {},
      };
    }
  }
}

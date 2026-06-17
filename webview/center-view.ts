// The center pane shows exactly one of these views at a time. A single value
// (not independent booleans) makes stacking structurally impossible — switching
// view fully replaces whatever was there.

// Review is intentionally NOT a center view — it opens as an editor tab (R5.5), so it
// lives in the doc-tab strip, not this mutually-exclusive switcher.
export type CenterView = 'editor' | 'board' | 'canvas';

export interface CenterViewDef {
  id: CenterView;
  label: string;
}

/** Ordered set of switchable center views, as shown in the top-bar switcher. */
export const CENTER_VIEWS: readonly CenterViewDef[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'board', label: 'Feature Board' },
  { id: 'canvas', label: 'Architecture Canvas' },
];

/** The view shown at first launch (and whenever there are no sessions). */
export const INITIAL_CENTER_VIEW: CenterView = 'editor';

/**
 * Map a shortcut / command-palette action id to the center view it opens (`null` if not a
 * view switch). Shared by the shortcut map and the palette so both stay in lockstep.
 */
export function centerViewForAction(actionId: string): CenterView | null {
  switch (actionId) {
    case 'openEditor':
      return 'editor';
    case 'openBoard':
      return 'board';
    case 'openArchitecture':
      return 'canvas';
    default:
      // 'openReview' deliberately returns null — Review opens as an editor tab, not a
      // center view, so it has no entry here (R5.5).
      return null;
  }
}

/**
 * Center view to show given the current view and live session count. With zero sessions
 * the only coherent view is the editor empty state (Board/Canvas make no sense over an
 * empty workbench), so closing the last session falls back to the initial start state;
 * otherwise the user's chosen view is preserved.
 */
export function nextCenterView(current: CenterView, sessionCount: number): CenterView {
  return sessionCount === 0 ? INITIAL_CENTER_VIEW : current;
}

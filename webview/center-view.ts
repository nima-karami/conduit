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
 * Map a shortcut / command-palette action id to the center view it opens, or
 * `null` if the action isn't a view switch. Shared by the keyboard shortcut map
 * and the command palette so both stay in lockstep.
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
 * Decide which center view to show given the current view and the live session
 * count. With zero sessions the only coherent view is the editor's empty state
 * (the Board/Canvas overlays make no sense floating over an empty workbench), so
 * closing the last session falls back to the same initial start state shown at
 * first launch. With one or more sessions the user's chosen view is preserved.
 *
 * Pure so the transition-to-empty behavior has a single, unit-tested source of
 * truth instead of an inline condition in the render component.
 */
export function nextCenterView(current: CenterView, sessionCount: number): CenterView {
  return sessionCount === 0 ? INITIAL_CENTER_VIEW : current;
}

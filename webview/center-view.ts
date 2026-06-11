// The center pane shows exactly one of these views at a time. A single value
// (not independent booleans) makes stacking structurally impossible — switching
// view fully replaces whatever was there.

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
      return null;
  }
}

import { SIDEBAR_STR } from './sidebar-strings';

/**
 * Pure builder for the Agents pane menu (right-click on empty list space). The tree orders itself
 * by status, so the old sort and group-by-project entries are gone; bulk close stays
 * (docs/specs/archive/2026-11-02-sidebar-agent-tree.md §6). The component maps each spec to a MenuItem.
 */

type AgentsPaneAction = 'new' | 'closeAll' | 'closeAllStale';

export interface AgentsPaneMenuItemSpec {
  action: AgentsPaneAction;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function buildAgentsPaneMenu(state: {
  sessionCount: number;
  staleCount: number;
}): AgentsPaneMenuItemSpec[] {
  return [
    { action: 'new', label: SIDEBAR_STR.newAgent },
    {
      action: 'closeAll',
      label: SIDEBAR_STR.closeAll,
      danger: true,
      separatorBefore: true,
      disabled: state.sessionCount === 0,
    },
    {
      action: 'closeAllStale',
      label: SIDEBAR_STR.closeAllStale,
      danger: true,
      disabled: state.staleCount === 0,
    },
  ];
}

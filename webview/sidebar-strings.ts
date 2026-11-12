// User-facing strings for the Spaces list, the agent tree and the session menu: one place for the
// future i18n seam (docs/specs/archive/2026-11-02-sidebar-agent-tree.md §9), in MCP_STR's function style.

import type { AgentGroup, AgentGroupKey, AgentState } from '../src/sidebar-state';
import type { AgentKind } from '../src/sidebar-view';

const plural = new Intl.PluralRules(undefined);
const number = new Intl.NumberFormat(undefined);

/** Plural-aware, locale-formatted count: "1 agent", "3 agents". */
function count(n: number, one: string, many: string): string {
  return `${number.format(n)} ${plural.select(n) === 'one' ? one : many}`;
}

const STATE: Record<AgentState, string> = {
  blocked: 'Needs you',
  done: 'Done',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
};

const GROUP: Record<AgentGroup, string> = { pinned: 'Pinned', ...STATE };

const KIND_TITLE: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  other: 'Other',
};

interface GroupTitleOpts {
  /** The Space's name for a By space group; absent = the group of agents without a Space. */
  spaceName?: string;
}

/** A group header's title: status groups keep their state words, the others name their bucket. */
function groupTitle(key: AgentGroupKey, o: GroupTitleOpts): string {
  if (key.startsWith('space:')) return o.spaceName ?? SPACELESS;
  if (key.startsWith('type:')) return KIND_TITLE[key.slice(5) as AgentKind] ?? key.slice(5);
  return GROUP[key as AgentGroup];
}
const SPACELESS = 'No space';

/** A mark's tooltip says a little more than its accessible state word. */
const MARK_TIP: Record<AgentState, string> = {
  blocked: 'Needs you',
  done: 'Done, not seen yet',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
};

export const SIDEBAR_STR = {
  spaces: 'Spaces',
  addSpace: 'Add space',
  newSpaceName: 'New space name',
  spaceNameHint: '1–80 characters',
  createSpaceFailed: 'Couldn’t create space',
  all: 'All',
  noSpace: 'No space',
  agents: 'Agents',
  newAgent: 'New agent',
  searchAgents: 'Search agents',
  filterPlaceholder: 'Filter sessions…',
  filterLabel: 'Filter sessions',
  clearFilter: 'Clear filter',
  settings: 'Settings',
  settingsTip: 'Settings (Ctrl+,)',
  agentCount: (n: number) => count(n, 'agent', 'agents'),
  live: (n: number) => `${number.format(n)} live`,
  state: (s: AgentState) => STATE[s],
  markTip: (s: AgentState) => MARK_TIP[s],
  group: (g: AgentGroupKey, o: GroupTitleOpts = {}) => groupTitle(g, o),
  /** The group header's accessible name counts roots, never descendants (spec §4). */
  groupLabel: (g: AgentGroupKey, roots: number, o: GroupTitleOpts = {}) =>
    `${groupTitle(g, o)} (${number.format(roots)})`,
  /**
   * The row's accessible name (plan selector table): name and own status, the Space only under
   * All, and a descendant's Needs you, which the own mark does not show.
   */
  rowLabel: (o: { name: string; state: AgentState; space?: string; descendantNeedsYou: boolean }) =>
    [o.name, STATE[o.state], o.space ?? '', o.descendantNeedsYou ? 'a sub-agent needs you' : '']
      .filter(Boolean)
      .join(', '),
  goTo: (name: string) => `Go to ${name}`,
  pin: 'Pin to top',
  unpin: 'Unpin',
  close: (name: string) => `Close ${name}`,
  relaunch: (name: string) => `Relaunch ${name}`,
  showKids: 'Show sub-agents',
  hideKids: 'Hide sub-agents',
  hiddenKids: (n: number) => count(n, 'hidden sub-agent', 'hidden sub-agents'),
  // Empty and filtered states (spec §9).
  firstRunTitle: 'No agents yet',
  firstRunHint: 'An agent is one terminal working across one or more folders. Run four at once.',
  startAgent: 'Start an agent',
  emptySpace: 'No agents in this space',
  noMatch: (q: string) => `No sessions match “${q}”`,
  loading: 'Loading agents…',
  // Space menus (spec §3).
  newAgentInSpace: 'New agent in space',
  newAgentNoSpace: 'New agent without a space',
  openBoard: 'Open board',
  renameSpace: 'Rename…',
  renameSpaceLabel: (name: string) => `Rename ${name}`,
  deleteSpace: 'Delete space…',
  deleteSpaceConfirm: 'Delete space',
  /** The ⋯ view menus on the Agents and Spaces panels. */
  viewMenu: {
    agentsLabel: 'Agents view options',
    spacesLabel: 'Spaces view options',
    customized: 'customized',
    reset: 'Reset',
    sort: 'Sort',
    group: 'Group',
    filter: 'Filter',
    agentType: 'Agent type',
    sorts: { recent: 'Recent activity', name: 'Name', status: 'Status', created: 'Created' },
    groups: { status: 'By status', space: 'By space', type: 'By agent type', none: 'None' },
    runningOnly: 'Running only',
    needsYou: 'Needs you',
    kinds: { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', other: 'Other' },
    spacesSorts: { manual: 'Manual', name: 'Name', recent: 'Recent' },
    hideEmpty: 'Hide empty spaces',
    noAgentsMatch: 'No agents match',
  },
  // Pane menu.
  closeAll: 'Close all sessions',
  closeAllStale: 'Close all stale sessions',
  /** The session context menu (webview/session-menu.ts). */
  menu: {
    goTo: 'Go to',
    pin: 'Pin to top',
    unpin: 'Unpin',
    split: 'Open in split pane',
    relaunch: 'Relaunch',
    approval: 'View approval',
    snooze: (minutes: number) => `Snooze for ${count(minutes, 'minute', 'minutes')}`,
    snoozedLeft: (minutes: number) => `${number.format(minutes)} min left`,
    timed: 'Timed message…',
    timedWaiting: (n: number) => `${number.format(n)} waiting`,
    rename: 'Rename',
    setIcon: 'Set icon…',
    duplicate: 'Duplicate session',
    moveSpace: 'Move to space…',
    copyHome: 'Copy home path',
    copyName: 'Copy name',
    close: 'Close',
    closeSubAgents: (n: number) => `Close all sub-agents (${number.format(n)})`,
    closeOthers: 'Close others',
    closeAll: 'Close all',
    closeSelected: (n: number) => `Close ${count(n, 'session', 'sessions')}`,
  },
} as const;

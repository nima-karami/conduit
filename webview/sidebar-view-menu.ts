import { inSelection } from '../src/agent-tree';
import { type AgentRuntime, agentOwnState, type SpaceSelection } from '../src/sidebar-state';
import {
  AGENT_GROUPINGS,
  AGENT_KINDS,
  AGENT_SORTS,
  type AgentKind,
  type AgentsView,
  DEFAULT_AGENTS_VIEW,
  DEFAULT_SPACES_VIEW,
  isDefaultAgentsView,
  isDefaultSpacesView,
  SPACES_SORTS,
  type SpacesView,
  toggleKind,
} from '../src/sidebar-view';
import type { Session } from '../src/types';
import { SIDEBAR_STR } from './sidebar-strings';

/**
 * What the ⋯ menus on the Agents and Spaces panels show, as plain data: `ViewMenu` only renders
 * it. Every option applies on pick and the menu stays open, so a sort and a filter can be set
 * in one visit.
 */

export interface ViewMenuOption {
  id: string;
  label: string;
  checked: boolean;
  /** Trailing dim text (how many agents the option would match). */
  hint?: string;
  onSelect: () => void;
}

export interface ViewMenuChip {
  id: AgentKind;
  label: string;
  checked: boolean;
  onSelect: () => void;
}

export interface ViewMenuSection {
  id: string;
  label: string;
  /** Radio: one of N. Check: independent switches. */
  kind: 'radio' | 'check';
  options: ViewMenuOption[];
  /** A multi-select row of chips under the options (agent type). */
  chips?: { label: string; items: ViewMenuChip[] };
}

export interface ViewMenuModel {
  sections: ViewMenuSection[];
  /** Null at the defaults: nothing to reset. */
  reset: (() => void) | null;
}

/** How many agents each Filter option would keep, so the menu says what a switch is worth. */
export function agentViewCounts(
  sessions: readonly Session[],
  runtime: AgentRuntime,
  askSessionIds: ReadonlySet<string>,
  /** The Space and search the list is already narrowed by: a hint counts what the switch would show. */
  scope: { selection: SpaceSelection; matchingIds: ReadonlySet<string> },
): { running: number; needsYou: number } {
  let running = 0;
  let needsYou = 0;
  for (const s of sessions) {
    if (!inSelection(s, scope.selection) || !scope.matchingIds.has(s.id)) continue;
    if (s.status !== 'running') continue;
    running++;
    // An unseen id is baselined, as in the tree, so it can never read as Done here either.
    if (
      agentOwnState(s, runtime.seen[s.id] ?? Number.POSITIVE_INFINITY, askSessionIds.has(s.id)) ===
      'blocked'
    )
      needsYou++;
  }
  return { running, needsYou };
}

const countHint = (n: number): string | undefined => (n > 0 ? String(n) : undefined);

export function buildAgentsViewMenu(
  view: AgentsView,
  counts: { running: number; needsYou: number },
  onChange: (next: AgentsView) => void,
): ViewMenuModel {
  const V = SIDEBAR_STR.viewMenu;
  const set = (patch: Partial<AgentsView>) => () => onChange({ ...view, ...patch });
  return {
    reset: isDefaultAgentsView(view) ? null : () => onChange({ ...DEFAULT_AGENTS_VIEW, kinds: [] }),
    sections: [
      {
        id: 'sort',
        label: V.sort,
        kind: 'radio',
        options: AGENT_SORTS.map((id) => ({
          id,
          label: V.sorts[id],
          checked: view.sort === id,
          onSelect: set({ sort: id }),
        })),
      },
      {
        id: 'group',
        label: V.group,
        kind: 'radio',
        options: AGENT_GROUPINGS.map((id) => ({
          id,
          label: V.groups[id],
          checked: view.group === id,
          onSelect: set({ group: id }),
        })),
      },
      {
        id: 'filter',
        label: V.filter,
        kind: 'check',
        options: [
          {
            id: 'runningOnly',
            label: V.runningOnly,
            checked: view.runningOnly,
            hint: countHint(counts.running),
            onSelect: set({ runningOnly: !view.runningOnly }),
          },
          {
            id: 'needsYou',
            label: V.needsYou,
            checked: view.needsYou,
            hint: countHint(counts.needsYou),
            onSelect: set({ needsYou: !view.needsYou }),
          },
        ],
        chips: {
          label: V.agentType,
          items: AGENT_KINDS.map((id) => ({
            id,
            label: V.kinds[id],
            checked: view.kinds.includes(id),
            onSelect: set({ kinds: toggleKind(view.kinds, id) }),
          })),
        },
      },
    ],
  };
}

export function buildSpacesViewMenu(
  view: SpacesView,
  onChange: (next: SpacesView) => void,
): ViewMenuModel {
  const V = SIDEBAR_STR.viewMenu;
  return {
    reset: isDefaultSpacesView(view) ? null : () => onChange({ ...DEFAULT_SPACES_VIEW }),
    sections: [
      {
        id: 'sort',
        label: V.sort,
        kind: 'radio',
        options: SPACES_SORTS.map((id) => ({
          id,
          label: V.spacesSorts[id],
          checked: view.sort === id,
          onSelect: () => onChange({ ...view, sort: id }),
        })),
      },
      {
        id: 'filter',
        label: V.filter,
        kind: 'check',
        options: [
          {
            id: 'hideEmpty',
            label: V.hideEmpty,
            checked: view.hideEmpty,
            onSelect: () => onChange({ ...view, hideEmpty: !view.hideEmpty }),
          },
        ],
      },
    ],
  };
}

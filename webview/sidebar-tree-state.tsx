import { createContext, useContext } from 'react';
import { type AgentRuntime, defaultSidebarUi, type SidebarUiState } from '../src/sidebar-state';
import type { AgentsView, SpacesView } from '../src/sidebar-view';

/**
 * What the App hands the sidebar tree (docs/plans/2026-11-02-sidebar-agent-tree.plan.md "Renderer
 * context signatures"). The App owns every value; the sidebar renders and requests.
 */
export interface SidebarTreeContextValue {
  ui: SidebarUiState;
  /** False until the host's saved sidebar state landed; an edit before it is never persisted. */
  hydrated: boolean;
  runtime: AgentRuntime;
  askSessionIds: ReadonlySet<string>;
  bindings: Readonly<Record<string, { cli?: string; handle?: string }>>;
  lastFocusedBySpace: Readonly<Record<string, string>>;
  /** Bumped by requestFilter; the sidebar reveals and focuses its filter on each change. */
  filterRequest: number;
  requestFilter(): void;
  updateUi(next: SidebarUiState): void;
  /** The ⋯ menus' options: app settings, shared by every window (src/sidebar-view.ts). */
  agentsView: AgentsView;
  spacesView: SpacesView;
  setAgentsView(next: AgentsView): void;
  setSpacesView(next: SpacesView): void;
  /** The flattened visible order, for next/previous agent; never sets App state. */
  reportVisibleIds(ids: readonly string[]): void;
}

const SidebarTreeContext = createContext<SidebarTreeContextValue | null>(null);
export const SidebarTreeProvider = SidebarTreeContext.Provider;

export function useSidebarTreeState(): SidebarTreeContextValue {
  const value = useContext(SidebarTreeContext);
  if (!value) throw new Error('useSidebarTreeState needs a SidebarTreeProvider');
  return value;
}

/** The window's sidebar UI and whether the host's one-shot init has landed. */
export interface SidebarUiSync {
  ui: SidebarUiState;
  hydrated: boolean;
}
export const INITIAL_SIDEBAR_UI_SYNC: SidebarUiSync = { ui: defaultSidebarUi(), hydrated: false };

const sameUi = (a: SidebarUiState, b: SidebarUiState) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Hydration is never echoed back as an edit, and an edit made before it is local only: it was
 * derived from defaults, so persisting it would overwrite the restored value.
 */
export function stepSidebarUi(
  sync: SidebarUiSync,
  event: { kind: 'init' | 'edit'; ui: SidebarUiState },
): { sync: SidebarUiSync; persist: SidebarUiState | null } {
  if (event.kind === 'init') return { sync: { ui: event.ui, hydrated: true }, persist: null };
  const persist = sync.hydrated && !sameUi(sync.ui, event.ui) ? event.ui : null;
  return { sync: { ui: event.ui, hydrated: sync.hydrated }, persist };
}

/** Spec §9 "Deleted Space/session": a removed Space selects All; vanished ids drop out. */
export function pruneSidebarUi(
  ui: SidebarUiState,
  sessionIds: ReadonlySet<string>,
  projectIds: ReadonlySet<string>,
): SidebarUiState {
  const goneSpace = ui.selection.kind === 'space' && !projectIds.has(ui.selection.projectId);
  const foldedSessions = ui.foldedSessions.filter((id) => sessionIds.has(id));
  const pinnedIds = ui.pinnedIds.filter((id) => sessionIds.has(id));
  if (
    !goneSpace &&
    foldedSessions.length === ui.foldedSessions.length &&
    pinnedIds.length === ui.pinnedIds.length
  )
    return ui;
  return {
    ...ui,
    selection: goneSpace ? { kind: 'all' } : ui.selection,
    foldedSessions,
    pinnedIds,
  };
}

import type { RightPaneTab } from './settings';

/** What the header toggles and imperative opens act on (sidebar-agent-tree spec §7). */
export interface RightPanelState {
  open: boolean;
  view: RightPaneTab;
  /** The persisted preference (settings.rightPaneTab). */
  remembered: RightPaneTab;
}

export type RightPanelEvent =
  /** A header toggle click. */
  | { kind: 'toggle'; view: RightPaneTab }
  /** An explicit pick that opens the panel (a toggle on an inactive view, the panel menu). */
  | { kind: 'open'; view: RightPaneTab; remember: boolean }
  /** A transient switch from code (search, reveal, messages, review): never persisted. */
  | { kind: 'imperative'; view: RightPaneTab; open: boolean };

export interface RightPanelNext {
  open: boolean;
  view: RightPaneTab;
  /** The preference to write, or null to leave it. */
  persist: RightPaneTab | null;
  /** The open state changed by the user's hand: review mode stops managing the panel. */
  userToggled: boolean;
}

/** Pressed + click closes; any other pick opens, remembered only when the user chose it. Pure. */
export function rightPanelTransition(s: RightPanelState, ev: RightPanelEvent): RightPanelNext {
  if (ev.kind === 'toggle' && s.open && s.view === ev.view)
    return { open: false, view: s.view, persist: null, userToggled: true };
  if (ev.kind === 'imperative')
    return { open: s.open || ev.open, view: ev.view, persist: null, userToggled: false };
  const remember = ev.kind === 'toggle' || ev.remember;
  return {
    open: true,
    view: ev.view,
    persist: remember && ev.view !== s.remembered ? ev.view : null,
    userToggled: !s.open,
  };
}

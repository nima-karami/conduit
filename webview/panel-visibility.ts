// Pure show/hide helpers for the two movable side panels (Sessions and Explorer).
// Visibility is LAYOUT state (lives in AppSettings), but the menu/palette
// derivations are kept here, free of React/DOM, so they're unit-testable in node.

/** The side panels the user can hide (the center pane is never hideable). */
export type HideablePanel = 'sessions' | 'explorer';

/** Layout-visibility slice of settings (collapsed = hidden). */
export interface PanelVisibility {
  sidebarCollapsed: boolean;
  explorerCollapsed: boolean;
}

export interface HideablePanelDef {
  panel: HideablePanel;
  title: string;
}

/** Ordered set of hideable panels (left-to-right in the default layout). */
export const HIDEABLE_PANELS: readonly HideablePanelDef[] = [
  { panel: 'sessions', title: 'Sessions' },
  { panel: 'explorer', title: 'Explorer' },
];

export function isPanelVisible(v: PanelVisibility, panel: HideablePanel): boolean {
  return panel === 'sessions' ? !v.sidebarCollapsed : !v.explorerCollapsed;
}

export interface PanelToggleSpec {
  panel: HideablePanel;
  label: string;
  /** Drives the check glyph: a check is shown when the panel is visible. */
  visible: boolean;
}

/**
 * Build the panel-toggle context-menu specs, one per hideable panel in a stable
 * order. Label is the bare panel name; the check glyph alone signals visibility
 * (a Hide/Show verb plus a checkmark was redundant).
 */
export function buildPanelToggleItems(v: PanelVisibility): PanelToggleSpec[] {
  return HIDEABLE_PANELS.map((def) => ({
    panel: def.panel,
    label: def.title,
    visible: isPanelVisible(v, def.panel),
  }));
}

/**
 * Title for a panel-toggle command in the palette. The sidebar uses
 * Collapse/Expand (matching its existing top-bar affordance); the Explorer uses
 * Hide/Show. `visible` is the panel's current state.
 */
export function paletteCommandTitle(panel: HideablePanel, visible: boolean): string {
  if (panel === 'sessions') return visible ? 'Collapse Sidebar' : 'Expand Sidebar';
  return visible ? 'Hide Explorer' : 'Show Explorer';
}

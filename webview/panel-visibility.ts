// Pure helpers for the show/hide state of the two movable side panels (Sessions
// and Explorer). Panel visibility is LAYOUT state — it lives in AppSettings next
// to panel order/widths — but the menu-item and palette-command derivations are
// kept here, free of React/DOM, so they're deterministic and unit-testable in
// node. The component (app.tsx) maps each spec onto a `MenuItem`/`PaletteEntry`,
// binding the real toggle + an `IconCheck` when the panel is visible.

/** The side panels the user can hide (the center pane is never hideable). */
export type HideablePanel = 'sessions' | 'explorer';

/** Layout-visibility slice of settings (collapsed = hidden). */
export interface PanelVisibility {
  sidebarCollapsed: boolean;
  explorerCollapsed: boolean;
}

export interface HideablePanelDef {
  panel: HideablePanel;
  /** Human label used in menu items (e.g. "Sessions"). */
  title: string;
}

/** Ordered set of hideable panels (left-to-right in the default layout). */
export const HIDEABLE_PANELS: readonly HideablePanelDef[] = [
  { panel: 'sessions', title: 'Sessions' },
  { panel: 'explorer', title: 'Explorer' },
];

/** Is the given panel currently shown? (collapse flag inverted.) */
export function isPanelVisible(v: PanelVisibility, panel: HideablePanel): boolean {
  return panel === 'sessions' ? !v.sidebarCollapsed : !v.explorerCollapsed;
}

/** A context-menu toggle spec for one panel. */
export interface PanelToggleSpec {
  panel: HideablePanel;
  /** "Hide Sessions" / "Show Explorer" — the verb reflects current state. */
  label: string;
  /** Drives the check glyph: a check is shown when the panel is visible. */
  visible: boolean;
}

/**
 * Build the panel-toggle context-menu specs from the current visibility, one per
 * hideable panel in a stable order. Visible panels read "Hide <panel>" and carry
 * `visible: true` (→ checked); hidden panels read "Show <panel>".
 */
export function buildPanelToggleItems(v: PanelVisibility): PanelToggleSpec[] {
  return HIDEABLE_PANELS.map((def) => {
    const visible = isPanelVisible(v, def.panel);
    return {
      panel: def.panel,
      label: `${visible ? 'Hide' : 'Show'} ${def.title}`,
      visible,
    };
  });
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

import { describe, expect, it } from 'vitest';
import {
  buildPanelToggleItems,
  HIDEABLE_PANELS,
  isPanelVisible,
  type PanelVisibility,
  paletteCommandTitle,
} from '../../webview/panel-visibility';

const ALL_VISIBLE: PanelVisibility = { sidebarCollapsed: false, explorerCollapsed: false };
const ALL_HIDDEN: PanelVisibility = { sidebarCollapsed: true, explorerCollapsed: true };

describe('panel-visibility', () => {
  it('lists exactly the two hideable side panels in a stable order', () => {
    expect(HIDEABLE_PANELS.map((p) => p.panel)).toEqual(['sessions', 'explorer']);
    for (const p of HIDEABLE_PANELS) {
      expect(p.title.length).toBeGreaterThan(0);
    }
  });

  it('reads the correct collapse flag for each panel (collapsed = not visible)', () => {
    expect(isPanelVisible(ALL_VISIBLE, 'sessions')).toBe(true);
    expect(isPanelVisible(ALL_VISIBLE, 'explorer')).toBe(true);
    expect(isPanelVisible(ALL_HIDDEN, 'sessions')).toBe(false);
    expect(isPanelVisible(ALL_HIDDEN, 'explorer')).toBe(false);
    expect(isPanelVisible({ sidebarCollapsed: true, explorerCollapsed: false }, 'sessions')).toBe(
      false,
    );
    expect(isPanelVisible({ sidebarCollapsed: true, explorerCollapsed: false }, 'explorer')).toBe(
      true,
    );
  });

  it('builds one toggle item per panel, in panel order', () => {
    const items = buildPanelToggleItems(ALL_VISIBLE);
    expect(items.map((i) => i.panel)).toEqual(['sessions', 'explorer']);
  });

  it('marks each visible panel and labels it Hide; hidden panels are labelled Show', () => {
    const visible = buildPanelToggleItems(ALL_VISIBLE);
    expect(visible.every((i) => i.visible)).toBe(true);
    expect(visible.map((i) => i.label)).toEqual(['Hide Sessions', 'Hide Explorer']);

    const hidden = buildPanelToggleItems(ALL_HIDDEN);
    expect(hidden.every((i) => i.visible)).toBe(false);
    expect(hidden.map((i) => i.label)).toEqual(['Show Sessions', 'Show Explorer']);
  });

  it('reflects mixed visibility independently', () => {
    const items = buildPanelToggleItems({ sidebarCollapsed: false, explorerCollapsed: true });
    const byPanel = Object.fromEntries(items.map((i) => [i.panel, i]));
    expect(byPanel.sessions.visible).toBe(true);
    expect(byPanel.sessions.label).toBe('Hide Sessions');
    expect(byPanel.explorer.visible).toBe(false);
    expect(byPanel.explorer.label).toBe('Show Explorer');
  });

  it('titles the sidebar palette command Collapse/Expand by state', () => {
    expect(paletteCommandTitle('sessions', true)).toBe('Collapse Sidebar');
    expect(paletteCommandTitle('sessions', false)).toBe('Expand Sidebar');
  });

  it('titles the explorer palette command Hide/Show by state', () => {
    expect(paletteCommandTitle('explorer', true)).toBe('Hide Explorer');
    expect(paletteCommandTitle('explorer', false)).toBe('Show Explorer');
  });

  it('is deterministic for a given visibility state', () => {
    expect(buildPanelToggleItems(ALL_VISIBLE)).toEqual(buildPanelToggleItems(ALL_VISIBLE));
  });
});

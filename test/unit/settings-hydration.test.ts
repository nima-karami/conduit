import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { splitSettingsPatch, uiSettingsEqual } from '../../webview/settings-hydration';

describe('settings hydration channels', () => {
  it('keeps server-only optimistic patches outside the UI echo gate', () => {
    const patch = splitSettingsPatch({ conduitMcp: false, sidebarCollapsed: true });
    expect(patch.server).toEqual({ conduitMcp: false });
    expect(patch.ui).toEqual({ sidebarCollapsed: true });
  });

  it('matches the UI echo even when the server rejects a key in the same edit', () => {
    const posted = { ...DEFAULT_SETTINGS, conduitMcp: false, sidebarCollapsed: true };
    const rejected = { ...DEFAULT_SETTINGS, conduitMcp: true, sidebarCollapsed: true };
    expect(uiSettingsEqual(rejected, posted)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { SERVER_SETTINGS_KEYS, type ServerSettings } from '../../src/contracts/server-protocol';
import { type AppSettings, DEFAULT_SETTINGS } from '../../src/settings';
import { mirrorServerKeys, serverPatchOf, uiOnly } from '../../src/settings-mirror';

const serverOf = (s: AppSettings): ServerSettings =>
  Object.fromEntries(SERVER_SETTINGS_KEYS.map((k) => [k, s[k]])) as ServerSettings;

describe('settings-mirror (D7)', () => {
  it('never strips server keys', () => {
    const ui: AppSettings = { ...DEFAULT_SETTINGS, theme: DEFAULT_SETTINGS.theme };
    const server = serverOf({
      ...DEFAULT_SETTINGS,
      trackCwd: !DEFAULT_SETTINGS.trackCwd,
      restoreSessions: !DEFAULT_SETTINGS.restoreSessions,
    });
    const merged = mirrorServerKeys(ui, server);
    for (const k of SERVER_SETTINGS_KEYS) {
      expect(Object.hasOwn(merged, k)).toBe(true);
      expect(merged[k]).toEqual(server[k]);
    }
    expect(merged.trackCwd).toBe(!DEFAULT_SETTINGS.trackCwd);
    expect(merged.logLevel).toBe(ui.logLevel);
    // A server value that is falsy still lands; a partial server object can't drop a key.
    const stripped = mirrorServerKeys(merged, { ...server, conduitMcp: false });
    expect(stripped.conduitMcp).toBe(false);
    expect(Object.keys(stripped).sort()).toEqual(Object.keys(ui).sort());
  });

  it('uiOnly keeps current server keys', () => {
    const current: AppSettings = { ...DEFAULT_SETTINGS, trackCwd: true, conduitMcp: true };
    const staleWindow: AppSettings = {
      ...DEFAULT_SETTINGS,
      trackCwd: false,
      conduitMcp: false,
      terminalFontSize: DEFAULT_SETTINGS.terminalFontSize + 2,
    };
    const next = uiOnly(staleWindow, current);
    expect(next.trackCwd).toBe(true);
    expect(next.conduitMcp).toBe(true);
    expect(next.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize + 2);
  });

  it('uiOnly keeps host-owned release-note acknowledgement from a stale window', () => {
    const current: AppSettings = { ...DEFAULT_SETTINGS, lastSeenVersion: '0.53.0' };
    const staleWindow: AppSettings = { ...DEFAULT_SETTINGS, lastSeenVersion: '0.52.0' };
    expect(uiOnly(staleWindow, current).lastSeenVersion).toBe('0.53.0');
  });

  it('uiOnly drops a renderer-supplied acknowledgement when none is persisted', () => {
    const incoming: AppSettings = { ...DEFAULT_SETTINGS, lastSeenVersion: '9.9.9' };
    expect(uiOnly(incoming, DEFAULT_SETTINGS).lastSeenVersion).toBeUndefined();
  });

  it('serverPatchOf picks only the server keys present in the patch', () => {
    expect(serverPatchOf({ trackCwd: false, theme: DEFAULT_SETTINGS.theme })).toEqual({
      trackCwd: false,
    });
    expect(serverPatchOf({ terminalFontSize: 14 })).toEqual({});
  });
});

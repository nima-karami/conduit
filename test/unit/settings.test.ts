import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, restoreSettings, serializeSettings } from '../../src/settings';

describe('settings persistence', () => {
  it('returns defaults for undefined / malformed blobs', () => {
    expect(restoreSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(restoreSettings('not json')).toEqual(DEFAULT_SETTINGS);
    expect(restoreSettings('{"version":999,"settings":{}}')).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a full settings object', () => {
    const s = { ...DEFAULT_SETTINGS, theme: 'slate', density: 'compact' as const, leftWidth: 300 };
    expect(restoreSettings(serializeSettings(s))).toEqual(s);
  });

  it('merges partial settings onto defaults and drops unknown keys', () => {
    const blob = JSON.stringify({ version: 1, settings: { theme: 'nord', bogus: 42 } });
    const out = restoreSettings(blob);
    expect(out.theme).toBe('nord');
    expect(out.fontUi).toBe(DEFAULT_SETTINGS.fontUi);
    expect((out as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('validates behaviour booleans and defaultAgentId', () => {
    const blob = JSON.stringify({
      version: 1,
      settings: {
        restoreSessions: 'yes',
        autoSwitchSession: false,
        reduceMotion: true,
        defaultAgentId: 'shell:pwsh',
      },
    });
    const out = restoreSettings(blob);
    expect(out.restoreSessions).toBe(true); // 'yes' invalid -> default true
    expect(out.autoSwitchSession).toBe(false);
    expect(out.reduceMotion).toBe(true);
    expect(out.confirmCloseRunning).toBe(true); // missing -> default
    expect(out.defaultAgentId).toBe('shell:pwsh');
  });

  it('defaults wordWrap off and validates it as a boolean', () => {
    expect(DEFAULT_SETTINGS.wordWrap).toBe(false);
    // missing -> default off
    expect(restoreSettings(JSON.stringify({ version: 1, settings: {} })).wordWrap).toBe(false);
    // explicit true round-trips
    expect(
      restoreSettings(JSON.stringify({ version: 1, settings: { wordWrap: true } })).wordWrap,
    ).toBe(true);
    // non-boolean -> default off
    expect(
      restoreSettings(JSON.stringify({ version: 1, settings: { wordWrap: 'on' } })).wordWrap,
    ).toBe(false);
  });

  it('rejects invalid enum values and clamps widths', () => {
    const blob = JSON.stringify({
      version: 1,
      settings: { density: 'huge', background: 'lava', leftWidth: 9999, rightWidth: 10 },
    });
    const out = restoreSettings(blob);
    expect(out.density).toBe(DEFAULT_SETTINGS.density);
    expect(out.background).toBe(DEFAULT_SETTINGS.background);
    expect(out.leftWidth).toBe(640); // clamped to max
    expect(out.rightWidth).toBe(180); // clamped to min
  });
});

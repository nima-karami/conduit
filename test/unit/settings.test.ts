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

  it('defaults panel visibility to all-shown and validates the flags as booleans', () => {
    expect(DEFAULT_SETTINGS.sidebarCollapsed).toBe(false);
    expect(DEFAULT_SETTINGS.explorerCollapsed).toBe(false);
    // missing -> default shown
    const missing = restoreSettings(JSON.stringify({ version: 1, settings: {} }));
    expect(missing.sidebarCollapsed).toBe(false);
    expect(missing.explorerCollapsed).toBe(false);
    // explicit hidden round-trips (visibility persists across reload)
    const hidden = restoreSettings(
      JSON.stringify({ version: 1, settings: { sidebarCollapsed: true, explorerCollapsed: true } }),
    );
    expect(hidden.sidebarCollapsed).toBe(true);
    expect(hidden.explorerCollapsed).toBe(true);
    // non-boolean -> default shown
    const bad = restoreSettings(
      JSON.stringify({ version: 1, settings: { explorerCollapsed: 'yes' } }),
    );
    expect(bad.explorerCollapsed).toBe(false);
  });

  it('allows full-range panel surface opacity (0..1), clamping out-of-range', () => {
    const at = (v: unknown) =>
      restoreSettings(JSON.stringify({ version: 1, settings: { surfaceOpacity: v } }))
        .surfaceOpacity;
    expect(at(0)).toBe(0); // full transparency now allowed (was clamped to 0.4)
    expect(at(0.25)).toBe(0.25); // value below the old 0.4 floor survives
    expect(at(1)).toBe(1);
    expect(at(-0.5)).toBe(0); // clamps to min 0
    expect(at(5)).toBe(1); // clamps to max 1
    expect(at('x')).toBe(DEFAULT_SETTINGS.surfaceOpacity); // non-number -> default
  });

  it('defaults the shared surface colour to the prior hardcoded look', () => {
    expect(DEFAULT_SETTINGS.surfaceColor).toBe('#0a0b0e');
    expect(DEFAULT_SETTINGS.codeOpacity).toBe(1);
    const out = restoreSettings(JSON.stringify({ version: 1, settings: {} }));
    expect(out.surfaceColor).toBe('#0a0b0e'); // missing -> default (back-compat)
    expect(out.codeOpacity).toBe(1);
  });

  it('validates the shared surface colour as a #rrggbb hex', () => {
    const at = (v: unknown) =>
      restoreSettings(JSON.stringify({ version: 1, settings: { surfaceColor: v } })).surfaceColor;
    expect(at('#1A2B3C')).toBe('#1A2B3C'); // valid hex round-trips (case preserved)
    expect(at('red')).toBe('#0a0b0e'); // named colour -> default
    expect(at('#fff')).toBe('#0a0b0e'); // shorthand -> default
    expect(at('#xyzxyz')).toBe('#0a0b0e'); // non-hex -> default
    expect(at(123)).toBe('#0a0b0e'); // non-string -> default
  });

  it('migrates the legacy codeBg key into the shared surfaceColor (I1)', () => {
    // Existing user with a custom round-1 code-block colour but no surfaceColor key:
    // the colour must carry over to the shared setting, not reset to the default.
    const legacy = restoreSettings(JSON.stringify({ version: 1, settings: { codeBg: '#112233' } }));
    expect(legacy.surfaceColor).toBe('#112233');

    // An invalid legacy value falls back to the default.
    const bad = restoreSettings(JSON.stringify({ version: 1, settings: { codeBg: 'nope' } }));
    expect(bad.surfaceColor).toBe('#0a0b0e');

    // A valid new surfaceColor wins over a legacy codeBg if both are present.
    const both = restoreSettings(
      JSON.stringify({ version: 1, settings: { surfaceColor: '#445566', codeBg: '#112233' } }),
    );
    expect(both.surfaceColor).toBe('#445566');

    // An invalid surfaceColor falls back to the legacy codeBg before the default.
    const fallback = restoreSettings(
      JSON.stringify({ version: 1, settings: { surfaceColor: 'bad', codeBg: '#778899' } }),
    );
    expect(fallback.surfaceColor).toBe('#778899');
  });

  it('clamps code-block opacity to 0..1', () => {
    const at = (v: unknown) =>
      restoreSettings(JSON.stringify({ version: 1, settings: { codeOpacity: v } })).codeOpacity;
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBe(0.5);
    expect(at(-1)).toBe(0);
    expect(at(2)).toBe(1);
    expect(at('x')).toBe(1); // non-number -> default
  });

  it('round-trips custom code-block styling', () => {
    const s = { ...DEFAULT_SETTINGS, surfaceColor: '#112233', codeOpacity: 0.4, surfaceOpacity: 0 };
    expect(restoreSettings(serializeSettings(s))).toEqual(s);
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

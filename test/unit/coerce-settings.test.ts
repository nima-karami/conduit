import { describe, expect, it } from 'vitest';
import { coerceSettings, DEFAULT_SETTINGS } from '../../src/settings';

// Helper: run coerceSettings on a partial plain object, merging it over an empty base.
const coerce = (partial: Record<string, unknown>) => coerceSettings(partial);

describe('coerceSettings — unknown keys dropped', () => {
  it('drops keys not present in AppSettings', () => {
    const result = coerce({ bogus: 42, evil: 'inject', theme: 'midnight' });
    expect((result as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(result.theme).toBe('midnight');
  });

  it('returns pure DEFAULT_SETTINGS for an empty payload', () => {
    expect(coerce({})).toEqual(DEFAULT_SETTINGS);
  });
});

describe('coerceSettings — valid values pass through', () => {
  it('round-trips a fully-specified valid payload', () => {
    const payload: Record<string, unknown> = {
      theme: 'slate',
      fontUi: 'hanken',
      fontMono: 'jetbrains',
      density: 'compact',
      background: 'mesh',
      bgIntensity: 'vivid',
      bgBlur: 12,
      surfaceOpacity: 0.5,
      surfaceColor: '#112233',
      codeOpacity: 0.8,
      customShader: 'void main(){}',
      leftWidth: 300,
      rightWidth: 400,
      layout: DEFAULT_SETTINGS.layout,
      sidebarCollapsed: true,
      explorerCollapsed: false,
      cardTitle: 'folder',
      cardSubtitle: 'status',
      cardDetail: 'none',
      sessionSort: 'active',
      sessionGroupByProject: false,
      shortcuts: { 'new-session': 'ctrl+n' },
      defaultAgentId: 'shell:pwsh',
      restoreSessions: false,
      autoSwitchSession: false,
      confirmCloseRunning: false,
      reduceMotion: true,
      wordWrap: true,
    };
    const result = coerce(payload);
    expect(result.theme).toBe('slate');
    expect(result.density).toBe('compact');
    expect(result.background).toBe('mesh');
    expect(result.bgIntensity).toBe('vivid');
    expect(result.bgBlur).toBe(12);
    expect(result.surfaceOpacity).toBe(0.5);
    expect(result.surfaceColor).toBe('#112233');
    expect(result.codeOpacity).toBe(0.8);
    expect(result.leftWidth).toBe(300);
    expect(result.rightWidth).toBe(400);
    expect(result.sidebarCollapsed).toBe(true);
    expect(result.explorerCollapsed).toBe(false);
    expect(result.cardTitle).toBe('folder');
    expect(result.sessionSort).toBe('active');
    expect(result.sessionGroupByProject).toBe(false);
    expect(result.shortcuts).toEqual({ 'new-session': 'ctrl+n' });
    expect(result.defaultAgentId).toBe('shell:pwsh');
    expect(result.restoreSessions).toBe(false);
    expect(result.wordWrap).toBe(true);
  });
});

describe('coerceSettings — wrong-typed values replaced by defaults', () => {
  it('replaces non-string theme with default', () => {
    expect(coerce({ theme: 42 }).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(coerce({ theme: null }).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(coerce({ theme: '' }).theme).toBe(DEFAULT_SETTINGS.theme); // empty string rejected by str()
  });

  it('replaces non-boolean flags with defaults', () => {
    expect(coerce({ restoreSessions: 'yes' }).restoreSessions).toBe(
      DEFAULT_SETTINGS.restoreSessions,
    );
    expect(coerce({ wordWrap: 1 }).wordWrap).toBe(DEFAULT_SETTINGS.wordWrap);
    expect(coerce({ sidebarCollapsed: 'true' }).sidebarCollapsed).toBe(
      DEFAULT_SETTINGS.sidebarCollapsed,
    );
    expect(coerce({ explorerCollapsed: 0 }).explorerCollapsed).toBe(
      DEFAULT_SETTINGS.explorerCollapsed,
    );
    expect(coerce({ sessionGroupByProject: 'yes' }).sessionGroupByProject).toBe(
      DEFAULT_SETTINGS.sessionGroupByProject,
    );
  });

  it('replaces non-number numeric fields with defaults', () => {
    expect(coerce({ bgBlur: 'lots' }).bgBlur).toBe(DEFAULT_SETTINGS.bgBlur);
    expect(coerce({ surfaceOpacity: 'high' }).surfaceOpacity).toBe(DEFAULT_SETTINGS.surfaceOpacity);
    expect(coerce({ codeOpacity: true }).codeOpacity).toBe(DEFAULT_SETTINGS.codeOpacity);
  });

  it('replaces non-number width fields with defaults', () => {
    expect(coerce({ leftWidth: 'wide' }).leftWidth).toBe(DEFAULT_SETTINGS.leftWidth);
    expect(coerce({ rightWidth: null }).rightWidth).toBe(DEFAULT_SETTINGS.rightWidth);
  });

  it('replaces invalid hex surfaceColor with default', () => {
    expect(coerce({ surfaceColor: 'red' }).surfaceColor).toBe(DEFAULT_SETTINGS.surfaceColor);
    expect(coerce({ surfaceColor: '#fff' }).surfaceColor).toBe(DEFAULT_SETTINGS.surfaceColor);
    expect(coerce({ surfaceColor: '#xyzxyz' }).surfaceColor).toBe(DEFAULT_SETTINGS.surfaceColor);
    expect(coerce({ surfaceColor: 123 }).surfaceColor).toBe(DEFAULT_SETTINGS.surfaceColor);
  });

  it('allows empty string for customShader and defaultAgentId (strOr)', () => {
    expect(coerce({ customShader: '' }).customShader).toBe('');
    expect(coerce({ defaultAgentId: '' }).defaultAgentId).toBe('');
  });
});

describe('coerceSettings — numeric range clamps', () => {
  it('clamps bgBlur to 0..24', () => {
    expect(coerce({ bgBlur: -5 }).bgBlur).toBe(0);
    expect(coerce({ bgBlur: 0 }).bgBlur).toBe(0);
    expect(coerce({ bgBlur: 12 }).bgBlur).toBe(12);
    expect(coerce({ bgBlur: 24 }).bgBlur).toBe(24);
    expect(coerce({ bgBlur: 100 }).bgBlur).toBe(24);
  });

  it('clamps surfaceOpacity to 0..1', () => {
    expect(coerce({ surfaceOpacity: -0.5 }).surfaceOpacity).toBe(0);
    expect(coerce({ surfaceOpacity: 0 }).surfaceOpacity).toBe(0);
    expect(coerce({ surfaceOpacity: 0.7 }).surfaceOpacity).toBe(0.7);
    expect(coerce({ surfaceOpacity: 1 }).surfaceOpacity).toBe(1);
    expect(coerce({ surfaceOpacity: 5 }).surfaceOpacity).toBe(1);
  });

  it('clamps codeOpacity to 0..1', () => {
    expect(coerce({ codeOpacity: -1 }).codeOpacity).toBe(0);
    expect(coerce({ codeOpacity: 2 }).codeOpacity).toBe(1);
  });

  it('clamps leftWidth and rightWidth to 180..640', () => {
    expect(coerce({ leftWidth: 10 }).leftWidth).toBe(180);
    expect(coerce({ leftWidth: 9999 }).leftWidth).toBe(640);
    expect(coerce({ rightWidth: 50 }).rightWidth).toBe(180);
    expect(coerce({ rightWidth: 700 }).rightWidth).toBe(640);
  });
});

describe('coerceSettings — enum whitelisting', () => {
  it('rejects invalid density, uses default', () => {
    expect(coerce({ density: 'huge' }).density).toBe(DEFAULT_SETTINGS.density);
    expect(coerce({ density: 'comfortable' }).density).toBe('comfortable');
    expect(coerce({ density: 'compact' }).density).toBe('compact');
  });

  it('rejects invalid fontSize, uses default (R4.14)', () => {
    expect(coerce({ fontSize: 'huge' }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(coerce({ fontSize: 3 }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    for (const v of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(coerce({ fontSize: v }).fontSize).toBe(v);
    }
  });

  it('rejects invalid background type, uses default', () => {
    expect(coerce({ background: 'lava' }).background).toBe(DEFAULT_SETTINGS.background);
    const valid = ['none', 'aurora', 'mesh', 'grid', 'flow', 'shader'] as const;
    for (const v of valid) {
      expect(coerce({ background: v }).background).toBe(v);
    }
  });

  it('rejects invalid bgIntensity, uses default', () => {
    expect(coerce({ bgIntensity: 'extreme' }).bgIntensity).toBe(DEFAULT_SETTINGS.bgIntensity);
    for (const v of ['subtle', 'balanced', 'vivid'] as const) {
      expect(coerce({ bgIntensity: v }).bgIntensity).toBe(v);
    }
  });

  it('rejects invalid sessionSort, uses default', () => {
    expect(coerce({ sessionSort: 'priority' }).sessionSort).toBe(DEFAULT_SETTINGS.sessionSort);
    const valid = ['manual', 'name', 'recent', 'active', 'status', 'project'] as const;
    for (const v of valid) {
      expect(coerce({ sessionSort: v }).sessionSort).toBe(v);
    }
  });

  it('rejects invalid cardTitle/cardSubtitle/cardDetail, uses default', () => {
    expect(coerce({ cardTitle: 'bogus' }).cardTitle).toBe(DEFAULT_SETTINGS.cardTitle);
    expect(coerce({ cardSubtitle: 99 }).cardSubtitle).toBe(DEFAULT_SETTINGS.cardSubtitle);
    expect(coerce({ cardDetail: 'none' }).cardDetail).toBe('none'); // valid value
  });
});

describe('coerceSettings — legacy codeBg migration', () => {
  it('migrates legacy codeBg to surfaceColor when surfaceColor is absent', () => {
    const result = coerce({ codeBg: '#112233' });
    expect(result.surfaceColor).toBe('#112233');
  });

  it('valid surfaceColor wins over legacy codeBg when both present', () => {
    const result = coerce({ surfaceColor: '#445566', codeBg: '#112233' });
    expect(result.surfaceColor).toBe('#445566');
  });

  it('falls back to legacy codeBg when surfaceColor is invalid', () => {
    const result = coerce({ surfaceColor: 'bad', codeBg: '#778899' });
    expect(result.surfaceColor).toBe('#778899');
  });

  it('falls back to default when both surfaceColor and codeBg are invalid', () => {
    const result = coerce({ surfaceColor: 'bad', codeBg: 'also-bad' });
    expect(result.surfaceColor).toBe(DEFAULT_SETTINGS.surfaceColor);
  });

  it('drops the codeBg key from the output (not in AppSettings)', () => {
    const result = coerce({ codeBg: '#112233' }) as unknown as Record<string, unknown>;
    expect(result.codeBg).toBeUndefined();
  });
});

describe('coerceSettings — osAttention setting (T1A)', () => {
  it('defaults osAttention to true', () => {
    expect(coerce({}).osAttention).toBe(true);
  });

  it('round-trips explicit true/false values', () => {
    expect(coerce({ osAttention: true }).osAttention).toBe(true);
    expect(coerce({ osAttention: false }).osAttention).toBe(false);
  });

  it('replaces non-boolean with default (true)', () => {
    expect(coerce({ osAttention: 'yes' }).osAttention).toBe(true);
    expect(coerce({ osAttention: 1 }).osAttention).toBe(true);
    expect(coerce({ osAttention: null }).osAttention).toBe(true);
  });
});

describe('coerceSettings — autoRelaunchStale setting (T1B)', () => {
  it('defaults autoRelaunchStale to false', () => {
    expect(coerce({}).autoRelaunchStale).toBe(false);
  });

  it('round-trips explicit true/false values', () => {
    expect(coerce({ autoRelaunchStale: true }).autoRelaunchStale).toBe(true);
    expect(coerce({ autoRelaunchStale: false }).autoRelaunchStale).toBe(false);
  });

  it('replaces non-boolean with default (false)', () => {
    expect(coerce({ autoRelaunchStale: 'yes' }).autoRelaunchStale).toBe(false);
    expect(coerce({ autoRelaunchStale: 1 }).autoRelaunchStale).toBe(false);
    expect(coerce({ autoRelaunchStale: null }).autoRelaunchStale).toBe(false);
  });
});

describe('coerceSettings — logging settings (Slice A)', () => {
  it('defaults logging to true and logLevel to info', () => {
    expect(coerce({}).logging).toBe(true);
    expect(coerce({}).logLevel).toBe('info');
  });

  it('round-trips a valid logging toggle', () => {
    expect(coerce({ logging: false }).logging).toBe(false);
    expect(coerce({ logging: true }).logging).toBe(true);
  });

  it('replaces a non-boolean logging value with the default (true)', () => {
    expect(coerce({ logging: 'yes' }).logging).toBe(true);
    expect(coerce({ logging: 1 }).logging).toBe(true);
  });

  it('whitelists every valid logLevel', () => {
    for (const v of ['off', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      expect(coerce({ logLevel: v }).logLevel).toBe(v);
    }
  });

  it('rejects an invalid logLevel, uses default (info)', () => {
    expect(coerce({ logLevel: 'verbose' }).logLevel).toBe('info');
    expect(coerce({ logLevel: 5 }).logLevel).toBe('info');
    expect(coerce({ logLevel: null }).logLevel).toBe('info');
  });
});

describe("coerceSettings — legacy background 'custom' → 'shader' migration (R4.9)", () => {
  it("maps the dropped 'custom' background to 'shader'", () => {
    expect(coerce({ background: 'custom' }).background).toBe('shader');
  });

  it("preserves the customShader source while migrating 'custom' → 'shader'", () => {
    const result = coerce({ background: 'custom', customShader: 'void main(){}' });
    expect(result.background).toBe('shader');
    expect(result.customShader).toBe('void main(){}');
  });

  it('passes the current backdrop kinds through unchanged', () => {
    const kinds = ['none', 'aurora', 'mesh', 'grid', 'flow', 'shader'] as const;
    for (const k of kinds) {
      expect(coerce({ background: k }).background).toBe(k);
    }
  });

  it("no longer accepts 'custom' as a distinct persisted value", () => {
    // After migration the output is never 'custom'.
    expect(coerce({ background: 'custom' }).background).not.toBe('custom');
  });

  it('still falls back to the default for an unknown background', () => {
    expect(coerce({ background: 'lava' }).background).toBe(DEFAULT_SETTINGS.background);
  });
});

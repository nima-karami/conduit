import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { bgPreviewStyle, pickBgPreviewInput } from '../../webview/bg-preview';

describe('bgPreviewStyle', () => {
  it('reflects blur and surface opacity in the exact CSS vars the real surfaces read', () => {
    const s = bgPreviewStyle({
      background: 'aurora',
      bgIntensity: 'balanced',
      bgBlur: 12,
      surfaceOpacity: 0.4,
    });
    expect(s.active).toBe(true);
    expect(s.vars['--bg-blur']).toBe('12px');
    expect(s.vars['--surface-alpha']).toBe('0.4');
  });

  it('updates live when blur changes (different input → different var)', () => {
    const base = { background: 'aurora', bgIntensity: 'balanced', surfaceOpacity: 0.7 } as const;
    const a = bgPreviewStyle({ ...base, bgBlur: 0 });
    const b = bgPreviewStyle({ ...base, bgBlur: 24 });
    expect(a.vars['--bg-blur']).toBe('0px');
    expect(b.vars['--bg-blur']).toBe('24px');
    expect(a.vars['--bg-blur']).not.toBe(b.vars['--bg-blur']);
  });

  it('updates live when surface opacity changes', () => {
    const base = { background: 'mesh', bgIntensity: 'balanced', bgBlur: 6 } as const;
    const a = bgPreviewStyle({ ...base, surfaceOpacity: 0 });
    const b = bgPreviewStyle({ ...base, surfaceOpacity: 1 });
    expect(a.vars['--surface-alpha']).toBe('0');
    expect(b.vars['--surface-alpha']).toBe('1');
  });

  it('drops the backdrop and marks inactive when background is none', () => {
    const s = bgPreviewStyle({
      background: 'none',
      bgIntensity: 'vivid',
      bgBlur: 10,
      surfaceOpacity: 0.5,
    });
    expect(s.active).toBe(false);
    expect(s.backdrop).toBe('transparent');
  });

  it('scales backdrop strength with intensity (subtle < balanced < vivid)', () => {
    const mk = (bgIntensity: 'subtle' | 'balanced' | 'vivid') =>
      bgPreviewStyle({ background: 'aurora', bgIntensity, bgBlur: 6, surfaceOpacity: 0.7 });
    expect(mk('subtle').intensity).toBeLessThan(mk('balanced').intensity);
    expect(mk('balanced').intensity).toBeLessThan(mk('vivid').intensity);
    // The multiplier is reflected in the backdrop string (stronger alpha values).
    expect(mk('subtle').backdrop).not.toBe(mk('vivid').backdrop);
  });

  it('produces a distinct backdrop per background type', () => {
    const types = ['aurora', 'mesh', 'grid'] as const;
    const backdrops = types.map(
      (background) =>
        bgPreviewStyle({ background, bgIntensity: 'balanced', bgBlur: 6, surfaceOpacity: 0.7 })
          .backdrop,
    );
    expect(new Set(backdrops).size).toBe(types.length);
  });

  it('clamps out-of-range blur and opacity defensively', () => {
    const s = bgPreviewStyle({
      background: 'aurora',
      bgIntensity: 'balanced',
      bgBlur: -5,
      surfaceOpacity: 2,
    });
    expect(s.vars['--bg-blur']).toBe('0px');
    expect(s.vars['--surface-alpha']).toBe('1');
  });

  it('pickBgPreviewInput narrows full settings to just the four background fields', () => {
    const input = pickBgPreviewInput(DEFAULT_SETTINGS);
    expect(input).toEqual({
      background: DEFAULT_SETTINGS.background,
      bgIntensity: DEFAULT_SETTINGS.bgIntensity,
      bgBlur: DEFAULT_SETTINGS.bgBlur,
      surfaceOpacity: DEFAULT_SETTINGS.surfaceOpacity,
    });
  });
});

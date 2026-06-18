import { describe, expect, it } from 'vitest';
import { buildMermaidConfig, buildMermaidThemeVariables } from '../../webview/mermaid-theme';

/** Fake CSSStyleDeclaration backed by a map; unknown vars return '' like the real one. */
function fakeCs(vars: Record<string, string>): CSSStyleDeclaration {
  return {
    getPropertyValue: (name: string) => vars[name] ?? '',
  } as unknown as CSSStyleDeclaration;
}

describe('buildMermaidThemeVariables', () => {
  it('maps app CSS variables into mermaid theme variables', () => {
    const cs = fakeCs({
      '--bg': '#0c0d10',
      '--panel': '#14171c',
      '--text': '#e6e6e6',
      '--border-2': '#3a3f48',
      '--text-dim': '#9aa0aa',
      '--accent': '#d9775c',
      '--font-ui': "'Hanken Grotesk', sans-serif",
    });
    const tv = buildMermaidThemeVariables(cs);
    expect(tv.background).toBe('#0c0d10');
    expect(tv.primaryColor).toBe('#14171c');
    expect(tv.primaryTextColor).toBe('#e6e6e6');
    expect(tv.lineColor).toBe('#9aa0aa');
    expect(tv.fontFamily).toContain('Hanken');
  });

  it('falls back to hardcoded hex when every variable is empty (no empty values)', () => {
    const tv = buildMermaidThemeVariables(fakeCs({}));
    for (const [key, value] of Object.entries(tv)) {
      expect(value, `themeVariables.${key} must not be empty`).not.toBe('');
    }
  });

  it('produces a legible light mapping for a light (paper) theme', () => {
    const cs = fakeCs({
      '--bg': '#f4f1ea',
      '--panel': '#ffffff',
      '--text': '#1a1a1a',
    });
    const tv = buildMermaidThemeVariables(cs);
    expect(tv.background).toBe('#f4f1ea');
    expect(tv.primaryColor).toBe('#ffffff');
    expect(tv.primaryTextColor).toBe('#1a1a1a');
  });
});

describe('buildMermaidConfig', () => {
  it("keeps securityLevel:'strict' and uses the base theme", () => {
    const cfg = buildMermaidConfig(fakeCs({}));
    expect(cfg.securityLevel).toBe('strict');
    expect(cfg.theme).toBe('base');
    expect(cfg.startOnLoad).toBe(false);
    expect(cfg.themeVariables).toBeTypeOf('object');
  });
});

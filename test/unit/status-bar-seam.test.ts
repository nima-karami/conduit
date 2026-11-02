import { describe, expect, it } from 'vitest';
import { CSS, theme } from './theme-color';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  const rule = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(CSS);
  if (!rule) throw new Error(`no ${selector} rule in styles.css`);
  return rule[1];
}

// sidebar-agent-tree spec §7: Neon lays the footer flush under the center content with exactly
// one hairline between them; Aero floats it one --gutter below like any other surface.
describe('center footer seam', () => {
  it('the center column spaces pane and footer by the shell gutter', () => {
    expect(ruleBody('.centercol')).toMatch(/gap:\s*var\(--gutter\);/);
  });

  it('Neon: zero gutter, the footer draws one top hairline and no ring', () => {
    const neon = theme('neon');
    expect(neon['--gutter']).toBe('0px');
    const body = ruleBody('[data-theme="neon"] .statusbar');
    expect(body).toMatch(/box-shadow:\s*none;/);
    expect(body).toMatch(/border-top:\s*1px solid var\(--border\);/);
  });

  it('Neon: the center surfaces above draw no bottom edge of their own', () => {
    // The doc surface's only edge is its --elev-2 shadow, which Neon flattens to nothing.
    expect(theme('neon')['--elev-2']).toMatch(/^0 0 #0000$/);
    for (const sel of ['.termwrap', '.centerpane', '.editor-group__body']) {
      expect(ruleBody(sel)).not.toMatch(/border(-bottom)?:/);
    }
    expect(CSS).not.toMatch(
      /\[data-theme="neon"\][^{]*\.(termwrap|centerpane|editor-group__body)[^{]*\{[^}]*border-bottom/,
    );
  });
});

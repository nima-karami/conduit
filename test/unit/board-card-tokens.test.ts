import { describe, expect, it } from 'vitest';
import { THEMES } from '../../webview/themes';
import { CSS, channels, contrast, over, resolve, theme } from './theme-color';

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  const rule = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(CSS);
  if (!rule) throw new Error(`no ${selector} rule in styles.css`);
  return rule[1];
}

/** The accent wash % a rule paints under its accent text, read from the shipped sheet. */
function washPercent(selector: string): number {
  const body = ruleBody(selector);
  const wash = /background:\s*color-mix\(in srgb, var\(--accent\) ([\d.]+)%, transparent\)/.exec(
    body,
  );
  if (!wash) throw new Error(`${selector} has no accent wash`);
  expect(body).toMatch(/(^|\s)color:\s*var\(--accent\);/);
  return Number(wash[1]);
}

// spec 2026-09-23-mf-board §7: accent text on its own accent tint, over the card fill.
describe('board card pills', () => {
  it('status and Start pills: accent text ≥ 4.5:1 on their wash over --raise, every theme', () => {
    for (const selector of ['.bcard__tstatus', '.bcard__start']) {
      const pct = washPercent(selector);
      for (const { id } of THEMES) {
        const t = theme(id);
        const accent = resolve(t, '--accent');
        const [r, g, b] = channels(accent);
        const bg = over(`rgba(${r}, ${g}, ${b}, ${pct / 100})`, resolve(t, '--raise'));
        expect(contrast(accent, bg), `${selector} in ${id} at ${pct}%`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

// An absolutely placed .bcard__acts covered the status pill (QA mf-board F1), and the padding
// reserved for it held the pill off the card's right edge (F2): the actions own a flow slot.
describe('board card hover actions', () => {
  it('take their own slot in the title row instead of floating over the header', () => {
    expect(ruleBody('.bcard__acts')).not.toMatch(/position:\s*absolute/);
    expect(ruleBody('.bcard__titlerow')).toMatch(/display:\s*flex/);
    for (const selector of ['.bcard__ticket', '.bcard__title']) {
      expect(ruleBody(selector), selector).not.toMatch(/padding-right/);
    }
  });
});

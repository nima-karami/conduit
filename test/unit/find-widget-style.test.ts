import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the find-widget restyle (spec 2026-08-31-review-fidelity §5) that are properties of
 * the STYLESHEET rather than of the rendered widget — `!important`, selector depth, the class
 * collision, and the reduced-motion escape. `test/e2e/find-widget.e2e.mjs` covers what it paints.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
/** Comments blanked so prose quoting a declaration can't be read as one. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

type Rule = { selectors: string[]; body: string };

/** Flat walk of top-level and at-rule-nested declaration blocks. */
function rules(): Rule[] {
  const out: Rule[] = [];
  const open: { selector: string; start: number; at: boolean }[] = [];
  let segment = 0;
  for (let i = 0; i < SRC.length; i++) {
    if (SRC[i] === '{') {
      const selector = SRC.slice(segment, i).trim();
      open.push({ selector, start: i + 1, at: selector.startsWith('@') });
      segment = i + 1;
    } else if (SRC[i] === '}') {
      const frame = open.pop();
      if (frame && !frame.at) {
        out.push({
          selectors: frame.selector
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          body: SRC.slice(frame.start, i),
        });
      }
      segment = i + 1;
    } else if (SRC[i] === ';' && open.length === 0) {
      segment = i + 1;
    }
  }
  return out;
}

const RULES = rules();
const findWidgetRules = RULES.filter((r) => r.selectors.some((s) => s.includes('.find-widget')));

describe('find widget restyle', () => {
  it('has rules at all', () => {
    expect(findWidgetRules.length).toBeGreaterThan(5);
  });

  it('never reaches for !important', () => {
    const offenders = findWidgetRules
      .filter((r) => /!\s*important/i.test(r.body))
      .map((r) => r.selectors.join(', '));
    expect(offenders).toEqual([]);
  });

  it('anchors every rule at the app editor container and goes no deeper than Monaco forces', () => {
    // AC-T4.5 words this as "the editor container plus one Monaco class". Monaco's own DOM needs
    // more than one: `.find-widget > .find-part .find-actions` is three levels of ITS markup, and
    // nothing shallower can name the button row. The invariant that actually stops a specificity
    // ladder is the one asserted here — anchored at `.viewer__monaco .find-widget`, and at most
    // two further compounds, which is the depth of the deepest thing the widget contains.
    const bad: string[] = [];
    for (const rule of findWidgetRules) {
      for (const sel of rule.selectors) {
        if (!sel.startsWith('.viewer__monaco .find-widget')) {
          bad.push(`not anchored: ${sel}`);
          continue;
        }
        const extra = sel
          .slice('.viewer__monaco .find-widget'.length)
          .split(/[\s>]+/)
          .filter(Boolean);
        if (extra.length > 2) bad.push(`too deep (${extra.length}): ${sel}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('routes the focus treatment through a focus-ring token', () => {
    const focusRules = findWidgetRules.filter((r) => r.selectors.some((s) => s.includes(':focus')));
    expect(focusRules.length).toBeGreaterThan(0);
    for (const rule of focusRules) {
      for (const [, prop, value] of rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
        if (prop !== 'box-shadow') continue;
        expect(`${rule.selectors[0]} => ${value.trim()}`).toMatch(/--focus-ring|none/);
      }
    }
  });

  it('gives the widget a reduced-motion escape Monaco does not ship', () => {
    // findWidget.css animates it in with `transition: transform 200ms linear` and has no guard.
    const guard =
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.find-widget[^}]*\{[^}]*transition:\s*none/;
    expect(guard.test(SRC)).toBe(true);
  });

  it('keeps the app toggle switch off Monaco class names', () => {
    // Monaco's expand chevron is `div.button.toggle`, so an unqualified `.toggle` dressed it as a
    // 34x19 switch. The app's switch is always a <button>, so the element qualifies the rule.
    const bare = RULES.filter((r) =>
      r.selectors.some((s) => /(^|[\s>,])\.toggle(--on)?(\s|$)/.test(s) && !/\.toggle__/.test(s)),
    ).flatMap((r) => r.selectors.filter((s) => /(^|[\s>,])\.toggle(--on)?(\s|$)/.test(s)));
    expect(bare).toEqual([]);
  });

  it('derives the inset ring from one declaration', () => {
    const declarations = [...SRC.matchAll(/^\s*--focus-ring-inset\s*:\s*([^;]+);/gm)];
    expect(declarations).toHaveLength(1);
    expect(declarations[0][1]).toContain('inset');
    // Neon needed the same inset ring first, for the same reason (an ancestor clips the box), so
    // it reads the token rather than restating its value.
    expect(SRC).toMatch(/--focus-ring:\s*var\(--focus-ring-inset\)/);
  });
});

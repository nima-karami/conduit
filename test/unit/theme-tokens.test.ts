import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_DEFAULTS } from '../../src/settings';
import { THEMES } from '../../webview/themes';

/**
 * The token contract's own instruction: "Add a contrast test. A 12-token x 9-theme matrix is
 * exactly where a hand-checked palette rots." Every --syn-* / --code-* / --diff-* FOREGROUND is
 * measured against the theme's own code surface (--code-base), which is ink in all three themes.
 *
 * Three ratios are deliberately below 4.5:1 and signed off in the design language, so they are
 * asserted AT their published value rather than skipped — a regression still fails, a re-tune
 * still has to be a deliberate edit. See docs/design-handoff/revamp/spec/Conduit Token Contract.txt
 * ("These are the Design Language's own values and are signed off as-is").
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');

/** Custom properties declared in one selector block, e.g. `:root` or `:root[data-theme="neon"]`. */
function tokensFor(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in styles.css`);
  const body = CSS.slice(start, CSS.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s{2}(--[\w-]+):\s*([^;]+);/gm)) out[m[1]] = m[2].trim();
  return out;
}

const ROOT = tokensFor(':root');

/** :root carries Aero Dark, so a theme block only needs to state what it changes. */
function theme(id: string): Record<string, string> {
  return id === 'aero-dark' ? ROOT : { ...ROOT, ...tokensFor(`:root[data-theme="${id}"]`) };
}

/** Resolve one level of `var(--x)` indirection (Neon states --syn-comment as var(--text-faint)). */
function resolve(tokens: Record<string, string>, name: string): string {
  const raw = tokens[name];
  if (!raw) throw new Error(`token ${name} is not declared`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  return ref ? resolve(tokens, ref[1]) : raw;
}

function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const FOREGROUNDS = [
  '--syn-default',
  '--syn-comment',
  '--syn-keyword',
  '--syn-string',
  '--syn-number',
  '--syn-type',
  '--syn-title',
  '--syn-built_in',
  '--syn-attr',
  '--syn-literal',
  '--syn-meta',
  '--syn-tag',
  '--code-line-number',
  '--code-cursor',
  '--diff-marker',
  '--diff-gutter-num',
];

/**
 * The signed-off muted tier, per theme: the comment/gutter/meta grey. The contract quotes it
 * on ink at 3.58:1 (Aero), 3.91:1 (Aero Dark) and 4.72:1 (Neon), and says explicitly not to
 * fix it or dim it further — "the gutter is the wrong place to save contrast".
 */
const MUTED: Record<string, { value: string; ratio: number }> = {
  aero: { value: '#6f748a', ratio: 3.58 },
  'aero-dark': { value: '#6f748a', ratio: 3.91 },
  neon: { value: '#7a71b8', ratio: 4.72 },
};

describe('theme token contrast on the code surface', () => {
  for (const { id } of THEMES) {
    const tokens = theme(id);
    const surface = resolve(tokens, '--code-base');
    const muted = MUTED[id];

    it(`${id}: the muted comment/gutter tier holds its signed-off ratio`, () => {
      expect(contrast(muted.value, surface)).toBeCloseTo(muted.ratio, 1);
    });

    for (const token of FOREGROUNDS) {
      it(`${id}: ${token} reads on ${surface}`, () => {
        const value = resolve(tokens, token);
        if (value === muted.value) {
          expect(contrast(value, surface)).toBeCloseTo(muted.ratio, 1);
          return;
        }
        expect(contrast(value, surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // The third signed-off value: the primary attention button paints --on-accent on --amber.
  it('aero: white on the amber attention fill holds its signed-off 2.62:1', () => {
    const tokens = theme('aero');
    expect(contrast(resolve(tokens, '--on-accent'), resolve(tokens, '--amber'))).toBeCloseTo(
      2.62,
      1,
    );
  });
});

describe('theme registry', () => {
  it('matches the per-theme defaults the host migration seeds from', () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual(Object.keys(THEME_DEFAULTS).sort());
    for (const t of THEMES) {
      expect({ fontUi: t.fontUi, fontMono: t.fontMono }).toEqual({
        fontUi: THEME_DEFAULTS[t.id].fontUi,
        fontMono: THEME_DEFAULTS[t.id].fontMono,
      });
    }
  });

  it('every theme id has a styles.css block, and Aero Dark is :root', () => {
    for (const t of THEMES) {
      if (t.id === 'aero-dark') continue;
      expect(CSS).toContain(`:root[data-theme="${t.id}"] {`);
    }
    expect(CSS).not.toContain(':root[data-theme="aero-dark"] {');
  });

  it("the theme's code surface is the settings default it seeds", () => {
    for (const t of THEMES) {
      expect(resolve(theme(t.id), '--code-base')).toBe(THEME_DEFAULTS[t.id].surfaceColor);
    }
  });

  it('theme blocks own shape and material only, never spacing or size', () => {
    for (const t of THEMES) {
      if (t.id === 'aero-dark') continue;
      const declared = Object.keys(tokensFor(`:root[data-theme="${t.id}"]`));
      expect(declared.filter((n) => n.startsWith('--density-'))).toEqual([]);
    }
    for (const t of THEMES) {
      if (t.id === 'aero-dark') continue;
      const block = CSS.slice(
        CSS.indexOf(`:root[data-theme="${t.id}"] {`),
        CSS.indexOf('\n}', CSS.indexOf(`:root[data-theme="${t.id}"] {`)),
      );
      expect(block).not.toMatch(/^\s{2}(height|padding|gap|font-size):/m);
    }
  });
});

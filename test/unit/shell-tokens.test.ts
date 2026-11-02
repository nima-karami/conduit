import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groundForTheme } from '../../src/theme-ground';
import { THEMES } from '../../webview/themes';

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');

/** Every use of a custom property, i.e. `var(--x)` reads — not its declarations. */
function readsOf(token: string): number {
  return CSS.split(`var(${token})`).length - 1;
}

/** The sheet's single `--density-topbar-h` declaration, verbatim. */
function topbarDecl(): string {
  const m = /--density-topbar-h:\s*([^;]+);/.exec(CSS);
  if (!m) throw new Error('--density-topbar-h is not declared');
  return m[1].trim();
}

/** `--density-band-h` as declared by each `:root…` block that sets one, as [selector, px]. */
function bandHeights(): [string, number][] {
  const out: [string, number][] = [];
  for (const [, sel, body] of CSS.matchAll(/^(:root[^{\n]*?)\s*\{([^}]*)\}/gm)) {
    const band = /--density-band-h:\s*([\d.]+)px/.exec(body);
    if (band) out.push([sel, Number(band[1])]);
  }
  if (out.length < 2) throw new Error(`expected a band height per density, found ${out.length}`);
  return out;
}

/**
 * Resolve the declared top-bar expression for one band height. It deliberately understands
 * only the shapes the sheet is allowed to use — an optional `round()`/`calc()` wrapper over
 * `band * factor` — so rewriting it into some other form fails loudly instead of passing
 * vacuously.
 */
function resolveTopbar(band: number): number {
  const decl = topbarDecl();
  const snap = /^round\((.+),\s*([\d.]+)px\)$/.exec(decl);
  const body = snap ? snap[1] : decl.replace(/^calc\((.*)\)$/, '$1');
  const factor = /var\(--density-band-h\)\s*\*\s*([\d.]+)/.exec(body);
  if (!factor) throw new Error(`unrecognised --density-topbar-h expression: ${decl}`);
  const raw = band * Number(factor[1]);
  if (!snap) return raw;
  const step = Number(snap[2]);
  return Math.round(raw / step) * step;
}

/**
 * The shape/material axes only exist if the shell actually consumes them. F0 declared these
 * with no consumers because they are all shell geometry; this is the assertion that they
 * stayed wired, so a later refactor can't quietly return the app to a flush, flat layout.
 */
describe('the shell consumes the shape + material axes', () => {
  for (const token of [
    '--win-pad',
    '--gutter',
    '--r-window',
    '--r-panel',
    '--win-hairline',
    '--elev-1',
    '--elev-2',
    '--theatre',
    '--label-case',
    '--label-track',
  ]) {
    it(`${token} is read by at least one rule`, () => {
      expect(readsOf(token)).toBeGreaterThan(0);
    });
  }

  it('the git band is gone: nothing styles or references .center-gitband', () => {
    expect(CSS).not.toContain('.center-gitband');
  });
});

describe('the chrome bands are one band', () => {
  // The sessions header, the centre tab row and the right-rail tabs are the same horizontal
  // band at the same altitude across three panels. They shipped at 34 / 34 / 40 with two
  // different label sizes, which read as three unrelated strips. One value now feeds all
  // three, and the top bar derives from it rather than being a fourth loose number.
  it('derives every band height from --density-band-h', () => {
    for (const token of ['--density-tabbar-h', '--density-rtab-h']) {
      expect(CSS).toContain(`${token}: var(--density-band-h)`);
    }
  });

  it('derives the top bar from the band rather than hardcoding it', () => {
    expect(topbarDecl()).toMatch(/var\(--density-band-h\)\s*\*\s*1\.5/);
  });

  it('gives compact its own band, so the 1.5x relationship survives the density switch', () => {
    const compact = CSS.slice(CSS.indexOf(':root[data-density="compact"]'));
    expect(compact).toMatch(/--density-band-h:\s*\d+px/);
    // Compact must NOT redeclare the derived heights — that would break the derivation.
    expect(compact).not.toContain('--density-topbar-h:');
  });

  // The top bar is the origin of everything below it, so a fractional height puts the whole
  // workbench on a half pixel and every hairline in the app smears across two device rows.
  // Compact's 31px band × 1.5 is 46.5px, which is exactly that. Asserting the resolved height
  // at each density (rather than a literal calc string) keeps the guarantee whichever way a
  // future band value moves.
  it('resolves the top bar to a whole number of pixels at every density', () => {
    for (const [density, band] of bandHeights()) {
      const topbar = resolveTopbar(band);
      expect(`${density}: ${topbar}px`).toBe(`${density}: ${Math.round(topbar)}px`);
      expect(Math.abs(topbar - band * 1.5)).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps every band height itself integral, so the bands below the top bar land clean', () => {
    for (const [, band] of bandHeights()) expect(band).toBe(Math.round(band));
  });

  it('sizes every band label from one token', () => {
    // .panel-title (Sessions) and .tab (centre) — the right rail's tab row became header
    // toggles (sidebar-agent-tree spec §7), so two bands remain, one size.
    expect(readsOf('--density-band-font')).toBeGreaterThanOrEqual(2);
  });
});

describe('the Neon chamfer is one continuous edge', () => {
  // The diagonal has drifted from the four sides twice: first reading the global --border
  // while each state set its own border-color, then reading --notch-line while ten rules
  // (.btn--primary, .btn--danger, .repo--active, the state ladder\u2026) set border-color direct.
  // Any mechanism that DERIVES the corner's colour separately has to be kept in sync by hand.
  // It now inherits the element's own border-top-color, so it cannot drift. The behavioural
  // guarantee is asserted against the running app in test/e2e/chamfer-edge.e2e.mjs.
  it('takes the diagonal\u2019s colour from the element\u2019s own border, not a second source', () => {
    const after = CSS.slice(CSS.indexOf('the Neon chamfer'), CSS.indexOf('Neon shell:'));
    expect(after).toContain('border-top-color: inherit');
    expect(after).not.toMatch(/::after\s*\{[^}]*background:\s*var\(--notch-line/s);
  });

  it('drives the session card border from that same token', () => {
    expect(CSS).toMatch(
      /\.session \{[^}]*--notch-line:[^}]*border: 1px solid var\(--notch-line\)/s,
    );
  });

  // The diagonal is an absolutely positioned ::after that pokes past the corner it redraws: on a
  // scroll container that is scrollable overflow (a 2 px sideways scrollbar on the MCP tools
  // dialog), and the cut lands at the bottom of the content, not the visible corner. A chamfered
  // frame keeps its corner; an inner element scrolls (.ctxmenu__scroll, .mcptools__scroll).
  it('a chamfered frame never scrolls itself', () => {
    const dir = join(__dirname, '..', '..', 'webview');
    const tsx = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const frames = [...tsx.matchAll(/className="([a-z0-9_-]+) chamfer(?:--sm)?"/g)].map(
      (m) => m[1],
    );
    expect(frames).toContain('mcptools');
    for (const cls of new Set(frames)) {
      const rules = [...CSS.matchAll(new RegExp(`(?:^|\\n)\\.${cls} \\{([^}]*)\\}`, 'g'))];
      expect(rules.length, cls).toBeGreaterThan(0);
      for (const [, body] of rules)
        expect(body, `.${cls}`).not.toMatch(/overflow(?:-[xy])?:\s*(?:auto|scroll)/);
    }
  });

  it('never notches a full-bleed panel — those ARE the window edge at Neon', () => {
    const chamfer = CSS.slice(CSS.indexOf('the Neon chamfer'), CSS.indexOf('Neon shell:'));
    expect(chamfer).not.toMatch(/:is\([^)]*\.sidebar/);
    expect(chamfer).not.toMatch(/:is\([^)]*\.rightpane[,)]/);
  });
});

describe('the pressed header toggle stays legible on hover', () => {
  // A pressed toggle carries the selection fill; the shared hover ladder would repaint it with
  // the hover wash, so it sits in the ladder's :not() list
  // (docs/specs/archive/2026-08-01-interaction-state-vocabulary.md).
  it('keeps the pressed toggle out of the hover ladder', () => {
    const start = CSS.indexOf('--- quiet:');
    const ladder = CSS.slice(start, CSS.indexOf('):hover', start));
    expect(ladder).toContain('.topbar__toggle[aria-pressed="true"]');
    expect(CSS).not.toMatch(/\.topbar__toggle\[aria-pressed="true"\]:hover\s*\{[^}]*color:/);
  });
});

describe('theme ground (the pre-first-paint window colour)', () => {
  it('matches each theme swatch, so the flash colour is the theme the user will see', () => {
    for (const t of THEMES) {
      expect(groundForTheme(t.id)).toBe(t.swatch[0]);
    }
  });

  it('falls back to Aero Dark for a missing or unrecognised stored theme', () => {
    const dark = groundForTheme('aero-dark');
    expect(groundForTheme(undefined)).toBe(dark);
    expect(groundForTheme('')).toBe(dark);
    expect(groundForTheme('midnight')).toBe(dark);
  });
});

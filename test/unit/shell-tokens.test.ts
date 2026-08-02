import { readFileSync } from 'node:fs';
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
    // .panel-title (Sessions), .tab (centre), .rtab (right rail) — three bands, one size.
    expect(readsOf('--density-band-font')).toBeGreaterThanOrEqual(3);
  });
});

describe('the Neon chamfer is one continuous edge', () => {
  // The diagonal used to read the global --border while each state set its own border-color,
  // so a selected card showed four accent sides and a grey diagonal, and an idle card showed
  // a diagonal and nothing else. Both consumers now read --notch-line.
  it('draws the diagonal from the surface\u2019s own edge token', () => {
    expect(CSS).toContain('background: var(--notch-line, var(--border))');
  });

  it('drives the session card border from that same token', () => {
    expect(CSS).toMatch(
      /\.session \{[^}]*--notch-line:[^}]*border: 1px solid var\(--notch-line\)/s,
    );
  });

  it('never notches a full-bleed panel — those ARE the window edge at Neon', () => {
    const chamfer = CSS.slice(CSS.indexOf('the Neon chamfer'), CSS.indexOf('Neon shell:'));
    expect(chamfer).not.toMatch(/:is\([^)]*\.sidebar/);
    expect(chamfer).not.toMatch(/:is\([^)]*\.right[,)]/);
  });
});

describe('the active view-switch segment stays legible on hover', () => {
  // Neon fills the active segment with the accent and picks its label against that fill; a
  // hover rule that recoloured the label to the accent put accent on accent and it vanished.
  // The per-component :not() that used to carry this is now one entry in the shared hover
  // ladder (docs/specs/2026-08-01-interaction-state-vocabulary.md) — same guarantee.
  it('keeps the active segment out of the hover ladder', () => {
    const start = CSS.indexOf('--- quiet:');
    const ladder = CSS.slice(start, CSS.indexOf('):hover', start));
    expect(ladder).toContain('.viewswitch__btn--on');
    expect(CSS).not.toMatch(/\.viewswitch__btn--on:hover\s*\{[^}]*color:/);
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

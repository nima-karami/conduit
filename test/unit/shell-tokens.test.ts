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
    expect(CSS).toMatch(/--density-topbar-h:\s*calc\(var\(--density-band-h\)\s*\*\s*1\.5\)/);
  });

  it('gives compact its own band, so the 1.5x relationship survives the density switch', () => {
    const compact = CSS.slice(CSS.indexOf(':root[data-density="compact"]'));
    expect(compact).toMatch(/--density-band-h:\s*\d+px/);
    // Compact must NOT redeclare the derived heights — that would break the derivation.
    expect(compact).not.toContain('--density-topbar-h:');
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
  it('scopes the hover rule to the inactive segments', () => {
    expect(CSS).toContain('.viewswitch__btn:not(.viewswitch__btn--on):hover');
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

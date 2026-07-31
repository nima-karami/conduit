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

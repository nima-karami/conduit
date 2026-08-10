import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Electron resolves `-webkit-app-region` into a window-level mask that ignores z-order and
 * ignores what is painted on top, so a control inside `.topbar`'s rect gets dragged instead
 * of clicked unless its layer explicitly says `no-drag` — the default `none` does not cut a
 * hole. That shipped as a modal whose close button was dead to the mouse wherever it
 * overlapped the top bar, worst on the Aero themes because their top bar is an inset card
 * that reaches further down the window than Neon's full-bleed one.
 *
 * Synthesized input bypasses the mask, so no e2e can guard this; these assertions are the
 * only thing standing between the fix and the next overlay that forgets.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
/** Comments blanked so prose quoting a property can't be read as a declaration. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** Every selector in the group that heads the block containing `at`. */
function selectorGroupAt(at: number): string[] {
  const braceBefore = SRC.lastIndexOf('{', at);
  const prevEnd = Math.max(SRC.lastIndexOf('}', braceBefore), SRC.lastIndexOf('*/', braceBefore));
  return SRC.slice(prevEnd + 1, braceBefore)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Selectors that declare `-webkit-app-region: <value>` anywhere in the sheet. */
function selectorsDeclaring(value: string): Set<string> {
  const found = new Set<string>();
  for (const m of SRC.matchAll(/-webkit-app-region:\s*([a-z-]+)/g)) {
    if (m[1] !== value) continue;
    for (const sel of selectorGroupAt(m.index)) found.add(sel);
  }
  return found;
}

/**
 * Overlay roots that can be painted over the top bar. Each is a `position: fixed` layer that
 * either covers the viewport or is positioned at an arbitrary point, so any of them can land
 * on the drag region. `.toasts` is deliberately absent: it is pinned bottom-right and cannot
 * reach the top bar.
 */
const OVERLAY_ROOTS = [
  '.modal__backdrop', // every modal, and the command palette (.palette__backdrop rides on it)
  '.ctxmenu',
  '.mermaid-zoom__backdrop',
  '.queuebackdrop',
];

describe('window drag region', () => {
  it('is claimed only by the top bar', () => {
    expect([...selectorsDeclaring('drag')]).toEqual(['.topbar']);
  });

  it.each(OVERLAY_ROOTS)('%s opts out of it', (root) => {
    expect(selectorsDeclaring('no-drag')).toContain(root);
  });

  it('keeps the top bar’s own controls clickable', () => {
    const optedOut = selectorsDeclaring('no-drag');
    for (const sel of ['.topbar button', '.topbar input', '.winctl']) {
      expect(optedOut).toContain(sel);
    }
  });

  it('covers every fixed-position overlay that can reach the top bar', () => {
    // Guards the list above against a NEW full-viewport overlay being added without opting
    // out. A fixed layer with `inset: 0` covers the top bar by construction.
    const fullScreen = new Set<string>();
    for (const m of SRC.matchAll(/position:\s*fixed/g)) {
      const body = SRC.slice(m.index, SRC.indexOf('}', m.index));
      if (!/\binset:\s*0\b/.test(body)) continue;
      for (const sel of selectorGroupAt(m.index)) fullScreen.add(sel);
    }
    const optedOut = selectorsDeclaring('no-drag');
    const exempt = new Set([
      '.bgfx', // painted behind everything; never takes pointer input
      '.theatre',
    ]);
    const missing = [...fullScreen].filter((s) => !optedOut.has(s) && !exempt.has(s));
    expect(missing).toEqual([]);
  });
});

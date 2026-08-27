import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.rcard__head` is `position: sticky`, and a sticky box is offset against its nearest SCROLLPORT.
 * `overflow: hidden` on the card makes the card that scrollport — one exactly as tall as its
 * content, so it never scrolls — and the header silently never sticks. `overflow: clip` clips the
 * same way without creating a scroll container.
 *
 * The behaviour itself is asserted in test/e2e/review-keymap-persist.e2e.mjs; this guards the
 * one-word declaration that makes it possible from being "tidied" back.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
/** Comments blanked so prose quoting a property can't be read as a declaration. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** The declarations of the block headed by exactly `selector`. */
function blockFor(selector: string): string {
  const at = SRC.search(new RegExp(`(^|\\})\\s*\\${selector}\\s*\\{`, 'm'));
  expect(at, `no "${selector} {" block in styles.css`).toBeGreaterThanOrEqual(0);
  const open = SRC.indexOf('{', at);
  return SRC.slice(open + 1, SRC.indexOf('}', open));
}

describe('review card / sticky file header', () => {
  it('the card clips without becoming a scroll container', () => {
    const card = blockFor('.rcard');
    expect(card).toMatch(/overflow:\s*clip\s*;/);
    expect(card).not.toMatch(/overflow:\s*(hidden|auto|scroll)\s*;/);
  });

  it('the card header is still sticky at the top of the scroller', () => {
    const head = blockFor('.rcard__head');
    expect(head).toMatch(/position:\s*sticky\s*;/);
    expect(head).toMatch(/top:\s*0\s*;/);
    expect(head).toMatch(/z-index:\s*\d+\s*;/);
  });

  // --panel-2 is a 5.5% white wash: on its own the rows scrolling under a PINNED header show
  // straight through it. The card's own opaque ground has to be the bottom layer.
  it('the pinned header paints an opaque ground under its wash', () => {
    const head = blockFor('.rcard__head');
    expect(head).toMatch(/background:[^;]*var\(--panel\)\s*;/);
    expect(head).not.toMatch(/background:\s*var\(--panel-2\)\s*;/);
  });

  it('the review scroller is the scrollport the header resolves against', () => {
    expect(blockFor('.review__scroll')).toMatch(/overflow-y:\s*auto\s*;/);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  INTERACTIVE_TARGET,
  reviewActionAllowed,
  reviewActionFor,
} from '../../webview/review-keymap';

/**
 * The Review keymap binds Enter to "open the current hunk", and the reveal effect parks focus on
 * a hunk header (or, for a binary file, the card's collapse toggle). Consuming Enter there would
 * leave every button inside a card dead to the keyboard — a regression against the surface as it
 * shipped, and against spec 2026-08-27-review-supercharge §9. This pins the rule against the real
 * markup rather than against a hand-written boolean.
 */

const CARD = `
  <div class="review__scroll" tabindex="-1">
    <section class="rcard" data-path="a.ts">
      <header class="rcard__head">
        <button type="button" class="rcard__toggle">a.ts</button>
        <button type="button" class="rcard__open">open</button>
        <button type="button" class="rcard__split">Split</button>
        <button type="button" class="rcard__reviewed">Mark reviewed</button>
      </header>
      <div class="rhunks">
        <button type="button" class="rhunk__jump" data-hunk="0">@@ -1,3 +1,3 @@</button>
        <button type="button" class="rcard__showrest">Show all</button>
        <pre class="rline"><span class="rline__text">const a = 1;</span></pre>
      </div>
    </section>
  </div>`;

const enter = { key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

/** The exact question the keydown handler asks of its event target. */
const takesEnter = (selector: string) => {
  document.body.innerHTML = CARD;
  const target = document.querySelector(selector);
  expect(target, `no ${selector} in the fixture`).not.toBeNull();
  const action = reviewActionFor(enter);
  expect(action, 'Enter must still map to openHunk').toBe('openHunk');
  if (action === null) throw new Error('unreachable');
  return reviewActionAllowed(action, 'Enter', !!target?.closest(INTERACTIVE_TARGET));
};

describe('Enter inside a Review card', () => {
  it('is left to every button a card carries', () => {
    for (const sel of [
      '.rcard__toggle',
      '.rcard__open',
      '.rcard__split',
      '.rcard__reviewed',
      '.rhunk__jump',
      '.rcard__showrest',
    ]) {
      expect(takesEnter(sel), `${sel} must keep its own Enter`).toBe(false);
    }
  });

  it('is taken when focus sits on the scroller, or on a plain diff row', () => {
    expect(takesEnter('.review__scroll')).toBe(true);
    expect(takesEnter('.rline__text')).toBe(true);
  });
});

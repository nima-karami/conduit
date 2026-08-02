/**
 * Neon's chamfer draws the cut corner's diagonal itself, because clip-path removes the
 * border along it. This asserts the diagonal is always the SAME COLOUR as the four sides.
 *
 * It has drifted twice. First the diagonal took the global --border while each state set
 * its own border-color, so a selected session card showed four accent sides and a grey
 * corner. That was fixed by routing both through --notch-line — a contract every future
 * state rule had to remember, and ten of them did not: `.btn--primary`, `.btn--danger`,
 * `.btn--ghost`, `.repo--active`, `.startroute:hover`, `.bcard:hover` and the state
 * ladder all set `border-color` directly, so the corner stayed grey behind an accent edge.
 *
 * The diagonal now inherits `border-top-color` from the element, so it cannot drift by
 * construction. This scenario is what stops someone reverting it to a re-derived fill.
 */

import { assert, closeApp, runScenario } from './harness.mjs';

/** Every class that ends up clip-path chamfered under Neon. */
const CHAMFERED = '.chamfer, .chamfer--sm, .session, .modal, .btn, .ctxmenu, .rcard';

runScenario('chamfer-edge', async ({ app, page, log }) => {
  await page.waitForSelector('.sidebar', { state: 'attached', timeout: 20000 });

  /** Surfaces on screen whose diagonal colour differs from their own border colour. */
  const survey = (sel) =>
    page.evaluate((s) => {
      // Set the theme and measure in ONE evaluation. runScenario cannot seed the profile,
      // and the host's state messages re-run the app's applyToDom, which puts data-theme
      // back — across two evaluations that race is live, within one it cannot run at all.
      document.documentElement.dataset.theme = 'neon';
      document.documentElement.getBoundingClientRect(); // flush the restyle before reading
      const seen = [];
      for (const el of document.querySelectorAll(s)) {
        const cs = getComputedStyle(el);
        const after = getComputedStyle(el, '::after');
        if (after.content === 'none') continue;
        // A border-drawn bar is the correct mechanism; a filled one is the reverted form.
        const diagonal =
          after.borderTopWidth !== '0px' ? after.borderTopColor : after.backgroundColor;
        seen.push({
          cls: el.className.toString().trim().replace(/\s+/g, '.'),
          border: cs.borderTopColor,
          diagonal,
          filled: after.borderTopWidth === '0px',
          sideWidth: cs.borderTopWidth,
          cornerWidth: after.borderTopWidth,
        });
      }
      return seen;
    }, sel);

  const check = async (where) => {
    const rows = await survey(CHAMFERED);
    assert(rows.length > 0, `${where}: no chamfered surface was on screen to check`);

    const reverted = rows.filter((r) => r.filled);
    assert(
      reverted.length === 0,
      `${where}: the diagonal must inherit the element's border colour, not re-derive a fill — ${reverted
        .map((r) => r.cls)
        .join(', ')}`,
    );

    // The corner continues the four sides, so it has to be the same weight as them. It
    // shipped at a hardcoded 2px against 1px borders and read as a separate bar laid over
    // the corner rather than part of the outline.
    const heavy = rows.filter((r) => !r.filled && r.cornerWidth !== r.sideWidth);
    assert(
      heavy.length === 0,
      `${where}: the cut corner must be the same width as the sides it continues — ${heavy
        .map((r) => `${r.cls} (sides ${r.sideWidth}, corner ${r.cornerWidth})`)
        .join('; ')}`,
    );

    const drifted = rows.filter((r) => r.border !== r.diagonal);
    assert(
      drifted.length === 0,
      `${where}: a chamfered surface's corner must match its four sides — ${drifted
        .map((r) => `${r.cls} (sides ${r.border}, corner ${r.diagonal})`)
        .join('; ')}`,
    );
    log(`${where}: ${rows.length} chamfered surface(s), every corner matches its sides ✓`);
  };

  // The new-session modal carries the two that drifted longest: a filled primary button
  // beside a default one, and an accent-bordered selected repo row.
  await page.evaluate(() => document.querySelector('.sidebar__head .iconbtn:last-child')?.click());
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.waitForTimeout(400);

  const inModal = await survey(CHAMFERED);
  log(`modal surfaces: ${inModal.map((r) => r.cls).join(' | ') || '(none)'}`);
  await check('new-session modal');

  // Hover re-colours the edge through the state ladder; the corner has to come along.
  await page.hover('.btn:not(.btn--primary)');
  await page.waitForTimeout(300);
  await check('modal / button hovered');

  await page.keyboard.press('Escape');
  await closeApp(app, page);
});

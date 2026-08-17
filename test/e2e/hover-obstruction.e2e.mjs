/**
 * An action overlay that is invisible must also be untouchable.
 *
 * Row/card actions in this app are kept mounted at `opacity: 0` and faded in on hover, which
 * avoids the reflow that display-toggling would cause — but without `pointer-events` gating they
 * stay hit-testable while invisible. `document.elementFromPoint` over a RESTING row then returns
 * a button nobody can see, and the two worst cases were destructive: the change row's *discard*
 * and the session card's *kill*.
 *
 * The invariant needs no knowledge of the fix: over a row nothing is hovering, nothing that is
 * effectively invisible may be the hit target.
 *
 * The sibling defect — a tooltip rendered over its own trigger (Monaco's find-widget
 * "Close (Escape)" label) — is NOT asserted here: Monaco raises that tooltip only when the OS
 * window is genuinely focused, and this suite runs hidden on purpose.
 * `test/unit/hover-overlays.test.ts` is its gate. See docs/runs/2026-08-17-hover-obstruction/.
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

/**
 * What is actually hit at (x,y). Opacity is the EFFECTIVE value — the product up the ancestor
 * chain — because these overlays fade the *container* (`.change__row-actions`) while the button
 * inside it still computes to opacity 1. Reading the button's own value silently false-passes.
 */
const hitAt = (page, x, y) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return null;
      const btn = el.closest('button, [role="button"], a');
      let effective = 1;
      for (let e = btn ?? el; e && e !== document.documentElement; e = e.parentElement) {
        effective *= Number(getComputedStyle(e).opacity);
      }
      return {
        el: `${el.tagName}.${el.className || ''}`.slice(0, 70),
        button: btn ? `${btn.tagName}.${btn.className || ''}`.slice(0, 70) : null,
        opacity: effective,
      };
    },
    [x, y],
  );

/** Park the pointer somewhere inert so nothing is hovered. */
const restPointer = async (page) => {
  await page.mouse.move(4, 420);
  await page.waitForTimeout(350);
};

/**
 * Sweep a row's right edge at several heights; a card's height differs between rest and hover, so
 * probing only the mid-line can sail straight past the control being guarded.
 */
async function invisibleHitAlongRightEdge(page, box, from = 8, to = 90, step = 6) {
  for (const fy of [0.25, 0.5, 0.75]) {
    for (let dx = from; dx <= to; dx += step) {
      const h = await hitAt(page, box.x + box.width - dx, box.y + box.height * fy);
      if (h?.button && h.opacity === 0) return { dx, fy, ...h };
    }
  }
  return null;
}

runScenario('hover-obstruction', async ({ page, log }) => {
  await openSession(page, { path: REPO });

  await page.locator('.rtab', { hasText: 'Changes' }).click();
  const change = page.locator('.change').first();
  await change.waitFor({ state: 'attached', timeout: 20000 });
  await restPointer(page);
  const changeHit = await invisibleHitAlongRightEdge(page, await change.boundingBox());
  log('resting change row:', JSON.stringify(changeHit ?? 'clean'));
  assert(
    !changeHit,
    `a resting change row exposed an invisible control: ${changeHit?.button} at ${changeHit?.dx}px from its right edge`,
  );
  log('resting change row exposes no invisible actions ✓');

  const card = page.locator('.session').first();
  await card.waitFor({ state: 'attached', timeout: 10000 });
  await restPointer(page);
  const cardHit = await invisibleHitAlongRightEdge(page, await card.boundingBox());
  log('resting session card:', JSON.stringify(cardHit ?? 'clean'));
  assert(
    !cardHit,
    `a resting session card exposed an invisible control: ${cardHit?.button} at ${cardHit?.dx}px from its right edge`,
  );
  log('resting session card exposes no invisible actions ✓');

  // The other half of the fix: gating the pointer must not disable the control. A
  // `pointer-events: none` with no matching `auto` on the reveal leaves these buttons
  // permanently dead, and the at-rest assertions above would still pass. Asserted on computed
  // style rather than by hit-testing, because the card's height changes on hover.
  await card.hover();
  await page.waitForTimeout(400);
  const revealed = await page.evaluate(() => {
    const kill = document.querySelector('.session .session__kill');
    if (!kill) return null;
    const cs = getComputedStyle(kill);
    return { pe: cs.pointerEvents, opacity: Number(cs.opacity) };
  });
  log('hovered session card kill button:', JSON.stringify(revealed));
  assert(revealed, 'precondition: the first session card should offer a kill button');
  assert(
    revealed.pe === 'auto' && revealed.opacity > 0,
    `hovering must make the kill button usable again — got pointer-events: ${revealed.pe}, opacity ${revealed.opacity}`,
  );
  log('hovered session card actions are reachable ✓');
});

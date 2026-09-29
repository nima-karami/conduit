/**
 * split-editor-focus-views — the focus landing (docs/specs/2026-09-28-split-editor.md §10) for the
 * views split-editor-focus does not open, and the close paths outside the strip's ×:
 *   VF  Ctrl+Tab onto Review, History and a commit-diff lands in that view: Review's scroller
 *       (its keymap is scoped to it), History's root, the commit-diff's modified editor
 *   FG  Focus Left Editor Group onto a Review that is already mounted lands in its scroller
 *   SB  group 1's split button, activated with no focus or pointer-down before it (as assistive
 *       tech can), splits group 1's shown doc while group 2 is active
 *   CO  the tab menu's Close Others lands focus in the surviving tab's view
 * A web tab takes no focus target: a focused guest page keeps Ctrl+Tab from the app, so focus
 * moved into it would trap tab cycling.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitBase } from './changes-fixture.mjs';
import { assert, openHistory, openReview, openSession, runScenario } from './harness.mjs';
import { G, openFromExplorer, sleep, tabOf, waitShown } from './split-editor-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'conduit-split-focus-views-'));
writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
writeFileSync(join(root, 'd.txt'), 'one\ntwo\n');
commitBase(root);
writeFileSync(join(root, 'd.txt'), 'one\nTWO changed\n');

const VIEWS = {
  review: { shown: '.review', focused: '.review__scroll' },
  history: { shown: '.gh', focused: '.gh' },
  'commit-diff': {
    shown: '.commit-diffhost .monaco-diff-editor',
    focused: '.commit-diffhost .monaco-diff-editor .editor.modified',
  },
};

runScenario('split-editor-focus-views', async ({ page, log }) => {
  const misses = [];
  const describeFocus = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()}.${[...a.classList].join('.')}` : 'none';
    });
  /** Records a miss unless focus settles inside `sel` (`exact`: on it) within group g. */
  const expectFocusIn = async (label, g, sel, exact = false) => {
    const ok = await page
      .waitForFunction(
        ({ scope, s, x }) => {
          const a = document.activeElement;
          if (!a?.closest(scope)) return false;
          return x ? a.matches(s) : !!a.closest(s);
        },
        { scope: G(g), s: sel, x: exact },
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    const at = await describeFocus();
    log(`${label}: expected ${sel} · focus is on ${at}`);
    if (!ok) misses.push(`${label}: focus is on ${at}, not ${sel}`);
  };
  const tabIndexShowing = (sel) =>
    page.evaluate(
      ({ scope, s }) => {
        const tabs = [...document.querySelectorAll(`${scope} [role="tab"]`)];
        return document.querySelector(`${scope} ${s}`)
          ? tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
          : -1;
      },
      { scope: G(1), s: sel },
    );

  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });
  log('session', sid);
  await openFromExplorer(page, 'a.ts');
  await openFromExplorer(page, 'b.ts');

  const at = {};
  await openReview(page);
  at.review = await tabIndexShowing(VIEWS.review.shown);
  await openHistory(page);
  await page.waitForSelector(`${G(1)} .gh__row`, { state: 'attached', timeout: 15000 });
  at.history = await tabIndexShowing(VIEWS.history.shown);
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__detail .commitview .gh__file', { timeout: 15000 });
  await page.click('.gh__detail .commitview .gh__file', { force: true });
  await page.waitForSelector(`${G(1)} ${VIEWS['commit-diff'].shown}`, { timeout: 15000 });
  at['commit-diff'] = await tabIndexShowing(VIEWS['commit-diff'].shown);
  log('tab indexes', JSON.stringify(at));
  assert(
    Object.values(at).every((i) => i > 0),
    `VF: a view has no tab after a doc tab (${JSON.stringify(at)})`,
  );

  // VF: Ctrl+Tab from the tab before each view.
  const docTabs = page.locator(`${G(1)} [role="tab"]`);
  for (const [kind, view] of Object.entries(VIEWS)) {
    await docTabs.nth(at[kind] - 1).click();
    await page.waitForFunction(
      ({ scope, i }) =>
        document.querySelectorAll(`${scope} [role="tab"]`)[i]?.getAttribute('aria-selected') ===
        'true',
      { scope: G(1), i: at[kind] - 1 },
      { timeout: 5000 },
    );
    await sleep(300);
    await page.keyboard.press('Control+Tab');
    await page
      .waitForSelector(`${G(1)} ${view.shown}`, { state: 'visible', timeout: 10000 })
      .catch(() => assert(false, `VF ${kind}: Ctrl+Tab did not show it`));
    await expectFocusIn(`VF Ctrl+Tab onto ${kind}`, 1, view.focused, kind !== 'commit-diff');
  }

  // SB: group 2 active, group 1 on a.ts; group 1's button is activated with no focus move.
  await tabOf(page, 1, 'b.ts').click();
  await waitShown(page, 1, 'b.ts', 'SB');
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'b.ts', 'SB');
  await tabOf(page, 1, 'a.ts').click();
  await waitShown(page, 1, 'a.ts', 'SB');
  await page
    .locator(`${G(2)} .monaco-editor .view-lines`)
    .first()
    .click();
  await page.waitForSelector(`${G(2)}[data-active="true"]`, { timeout: 5000 });
  await page.evaluate((sel) => document.querySelector(`${sel} .tabbar__split`).click(), G(1));
  const sb = await waitShown(page, 2, 'a.ts', 'SB bare left split button').then(
    () => null,
    (e) => e.message,
  );
  log(`SB bare left split button with the right group active: ${sb ?? 'split a.ts'}`);
  if (sb) misses.push(sb);

  // FG: the Review in group 1 is already mounted when the command lands on it.
  await docTabs.nth(at.review).click();
  await page.waitForSelector(`${G(1)} .review`, { state: 'visible', timeout: 10000 });
  await page
    .locator(`${G(2)} .monaco-editor .view-lines`)
    .first()
    .click();
  await page.waitForSelector(`${G(2)}[data-active="true"]`, { timeout: 5000 });
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill('>Focus Left Editor Group');
  await page
    .locator('.palette__title', { hasText: /^Focus Left Editor Group$/ })
    .waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  await expectFocusIn('FG Focus Left Editor Group onto Review', 1, '.review__scroll', true);

  // CO: Close Others on b.ts (not the shown tab) lands focus in b.ts's editor.
  await tabOf(page, 1, 'b.ts').click({ button: 'right' });
  const closeOthers = page.locator('.ctxmenu__item', { hasText: /^Close others$/ });
  await closeOthers.waitFor({ timeout: 5000 }).catch(() => assert(false, 'CO: no Close others'));
  await closeOthers.click();
  await page
    .waitForFunction((sel) => document.querySelectorAll(`${sel} [role="tab"]`).length === 1, G(1), {
      timeout: 10000,
    })
    .catch(() => assert(false, 'CO: Close others left more than one tab'));
  await waitShown(page, 1, 'b.ts', 'CO');
  const coOk = await page
    .waitForFunction(
      (sel) =>
        (window.monaco?.editor.getEditors() ?? []).some(
          (e) =>
            e.hasTextFocus() &&
            e.getDomNode()?.closest(sel) &&
            e.getModel()?.uri.path.endsWith('/b.ts'),
        ),
      G(1),
      { timeout: 3000 },
    )
    .then(() => true)
    .catch(() => false);
  const coAt = await describeFocus();
  log(`CO Close others: expected b.ts's editor · focus is on ${coAt}`);
  if (!coOk) misses.push(`CO: focus is on ${coAt}, not b.ts's editor`);

  assert(misses.length === 0, `focus missed ${misses.length} step(s):\n  ${misses.join('\n  ')}`);
});

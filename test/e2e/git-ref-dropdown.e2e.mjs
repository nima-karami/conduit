/**
 * Real-app smoke: the git History tab's ref filter is the app's own dropdown, not a native
 * <select>. Opens History on a git repo, asserts there's no native <select> in the filter
 * bar, opens the custom dropdown, and picks a ref — asserting the menu closes and the
 * trigger label reflects the selection.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { assert, openSession, REPO, runScenario } from './harness.mjs';

runScenario('git-ref-dropdown', async ({ page, log }) => {
  // The Conduit repo itself: a real git repo with branches/tags so refOptions is non-empty.
  await openSession(page, { path: REPO });

  await page.waitForSelector('.git-indicator__history', { timeout: 20000 });
  await page.click('.git-indicator__history');
  await page.waitForSelector('.gh__filterbar', { timeout: 15000 });
  // The ref filter renders only once refOptions populates (history loaded); this waits for it.
  await page.waitForSelector('button.gh__reffilter', { timeout: 15000 });

  const nativeSelects = await page.$$eval('.gh__filterbar select', (els) => els.length);
  assert(
    nativeSelects === 0,
    `expected no native <select> in the filter bar, found ${nativeSelects}`,
  );

  const trigger = await page.$('button.gh__reffilter');
  assert(trigger, 'custom ref-filter trigger button should be present');

  await trigger.click();
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  const items = await page.$$eval('.ctxmenu .ctxmenu__item', (els) =>
    els.map((e) => e.innerText.trim()).filter(Boolean),
  );
  log('menu items:', JSON.stringify(items));
  assert(items.length >= 2, `menu should have "All branches" + >=1 ref, got ${items.length}`);
  assert(
    items.some((i) => /all/i.test(i)),
    'menu should include an "All branches" row',
  );

  // Pick the first real ref (item[0] is "All branches"); label should update + menu close.
  const refLabel = items[1];
  await page.$$eval(
    '.ctxmenu .ctxmenu__item',
    (els, target) => {
      const el = els.find((e) => e.innerText.trim() === target);
      if (el) el.click();
    },
    refLabel,
  );
  await page.waitForTimeout(500);

  assert((await page.$('.ctxmenu')) === null, 'menu should close after selecting a ref');
  const newLabel = (await page.$eval('button.gh__reffilter', (e) => e.innerText)).trim();
  log('label after select:', JSON.stringify(newLabel));
  assert(
    newLabel === refLabel,
    `trigger label should reflect the selected ref "${refLabel}", got "${newLabel}"`,
  );
});

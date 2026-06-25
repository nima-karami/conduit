/**
 * Explorer file-type icons (real-app smoke).
 *
 * Verifies the icon-pack appearance setting actually changes the Explorer: the default
 * `minimal` pack renders a type icon on file rows; switching to `none` removes them.
 * Drives the real app (the Conduit repo is the opened project) + the updateSettings
 * round-trip.
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

const fileRowByName = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

runScenario('explorer-icons', async ({ page, log }) => {
  await openSession(page, { path: REPO });

  // Capture the live settings object so we can post a valid full updateSettings payload.
  await page.evaluate(() => {
    window.__settings = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') window.__settings = m.settings;
    });
    window.agentDeck.post({ type: 'ready' });
  });

  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 20000 });

  const row = fileRowByName(page, 'package.json').first();
  await row.waitFor({ state: 'attached', timeout: 20000 });

  // Default pack is `minimal` → a file row carries a type icon (svg.filerow__icon).
  const minimalIcons = await row.locator('.filerow__icon').count();
  assert(minimalIcons >= 1, 'file row should show a type icon in the default (minimal) pack');
  log('minimal pack: file icon present ✓');

  // Flip to `none` via the real settings round-trip; the icon must disappear.
  const cur = await page.evaluate(() => window.__settings);
  assert(cur, 'should have captured the live settings object');
  await page.evaluate(
    (s) => window.agentDeck.post({ type: 'updateSettings', settings: { ...s, iconPack: 'none' } }),
    cur,
  );

  await row
    .locator('.filerow__icon')
    .first()
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => {});
  const noneIcons = await row.locator('.filerow__icon').count();
  assert(noneIcons === 0, 'file row should have NO type icon in the none pack');
  log('none pack: file icon removed ✓');
});

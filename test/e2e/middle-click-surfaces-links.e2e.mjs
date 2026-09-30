/**
 * Middle-click opens in a background tab, per surface (docs/specs/2026-09-22-middle-click-new-tab.md
 * §7 AC-7/10): markdown links (S10), breadcrumb dropdown (S11) and palette file row (S12). Starts
 * with a.ts pinned and b.ts opened in the background (replayed from
 * middle-click-surfaces-search). Every open asserts the spec's "unchanged" snapshot.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs middle-click-surfaces-links`.
 */

import {
  assert,
  clearSpyCalls,
  closeApp,
  getSpyCalls,
  openSession,
  phase,
  runScenario,
  spyMain,
} from './harness.mjs';
import {
  middleClickJitter,
  sameSnapshot,
  snapshotUnchanged,
  statusText,
  tabInfo,
  waitStatus,
} from './middle-click-fixture.mjs';
import {
  backgroundOpener,
  exact,
  fmt,
  openPalette,
  paletteRow,
  replayPinnedAWithBackgroundB,
  treeRow,
  writeSurfacesRepo,
} from './middle-click-surfaces-helpers.mjs';
import { waitActive } from './nav-history-fixture.mjs';

runScenario('middle-click-surfaces-links', async ({ app, page, log }) => {
  const root = writeSurfacesRepo();
  await openSession(page, { path: root });
  const expectBackgroundOpen = backgroundOpener(page, log);

  phase('replay a.ts pinned, b.ts in the background');
  await replayPinnedAWithBackgroundB(page);

  phase('S10 markdown links');
  await treeRow(page, 'README.md').first().waitFor({ state: 'visible', timeout: 15000 });
  await treeRow(page, 'README.md').first().click();
  assert(await waitActive(page, 'README.md', 15000), 'S10: README.md never became active');
  const mdLink = (text) => page.locator('.markdown a', { hasText: text }).first();
  await mdLink('external link').waitFor({ state: 'visible', timeout: 15000 });

  await spyMain(app, [{ api: 'openExternal' }]);
  await clearSpyCalls(app);
  {
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    await middleClickJitter(page, mdLink('external link'));
    const externalCalls = async () =>
      (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');
    const deadline = Date.now() + 5000;
    while ((await externalCalls()).length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    // A duplicate host-side open (C5) would land after the renderer's; give it time to show.
    await page.waitForTimeout(800);
    const calls = await externalCalls();
    assert(
      calls.length === 1,
      `AC-7: expected exactly one host openExternal, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.args))}`,
    );
    assert(
      String(calls[0].args[0]).startsWith('http://127.0.0.1:9'),
      `AC-7: openExternal got the wrong URL ${JSON.stringify(calls[0].args)}`,
    );
    const tabs = await tabInfo(page);
    assert(
      tabs.length === tabsBefore.length,
      `AC-7: an external link must add no tab; before ${fmt(tabsBefore)}, after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `AC-7: state changed — ${diff}`);
    log('AC-7 external markdown link: one openExternal, no tab ✓');
  }

  {
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    await middleClickJitter(page, mdLink('b link'));
    const announced = await waitStatus(page, 'b.ts is already open', 8000)
      .then(() => true)
      .catch(() => false);
    assert(
      announced,
      `S10 b.ts link: status should read "b.ts is already open", got ${JSON.stringify(await statusText(page))}`,
    );
    const tabs = await tabInfo(page);
    assert(
      tabs.length === tabsBefore.length,
      `S10 b.ts link: already-open must add no tab; after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `S10 b.ts link: state changed — ${diff}`);
    log('S10 link to an open file: "already open", nothing changes ✓');
  }

  await expectBackgroundOpen(
    'S10 markdown link with #fragment',
    mdLink('c link'),
    'c.ts',
    'Opened c.ts in a background tab',
  );
  assert(
    (await tabInfo(page)).find((t) => t.active)?.title === 'README.md',
    'S10: README.md must stay the active tab',
  );

  phase('S11 breadcrumb dropdown');
  await page
    .locator('.breadcrumb-bar__seg', { hasText: exact('README.md') })
    .first()
    .click();
  const crumbItem = page.locator('.ctxmenu__item', { hasText: exact('d.ts') }).first();
  await crumbItem.waitFor({ state: 'visible', timeout: 15000 });
  await expectBackgroundOpen(
    'S11 breadcrumb dropdown',
    crumbItem,
    'd.ts',
    'Opened d.ts in a background tab',
  );
  const menuClosed = await page
    .waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(menuClosed, 'S11: the breadcrumb dropdown should close after a middle-click select');

  phase('S12 palette');
  await openPalette(page, 'palettepick');
  await paletteRow(page, 'palettepick.ts').waitFor({ state: 'visible', timeout: 15000 });
  await expectBackgroundOpen(
    'S12 palette file row',
    paletteRow(page, 'palettepick.ts'),
    'palettepick.ts',
    'Opened palettepick.ts in a background tab',
  );
  assert(
    await page.locator('.palette').first().isVisible(),
    'AC-10: the palette must stay open after a middle-click',
  );
  assert(
    await page.evaluate(
      () => document.activeElement?.classList.contains('palette__input') ?? false,
    ),
    'AC-10: .palette__input must keep focus',
  );
  log('AC-10 palette stays open with its input focused ✓');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });

  await closeApp(app, page);
});

/**
 * Middle-click opens in a background tab (docs/specs/2026-09-22-middle-click-new-tab.md §7
 * AC-4/13): the oversize diff notice (S9), a palette file owned by another session (D2), and a
 * background search-match tab opening at its line when later activated. Starts with a.ts pinned
 * and b.ts opened in the background (replayed from middle-click-surfaces-search).
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs middle-click-surfaces-sessions`.
 */

import { assert, closeApp, openSession, phase, runScenario } from './harness.mjs';
import {
  middleClickJitter,
  sameSnapshot,
  snapshotUnchanged,
  statusText,
  tabInfo,
  waitStatus,
  waitTab,
} from './middle-click-fixture.mjs';
import {
  B_TOKEN_LINE,
  backgroundOpener,
  changeRow,
  editorState,
  exact,
  fmt,
  openPalette,
  paletteRow,
  replayPinnedAWithBackgroundB,
  writeSurfacesRepo,
} from './middle-click-surfaces-helpers.mjs';
import { selectSession, waitActive, waitCursor } from './nav-history-fixture.mjs';

runScenario('middle-click-surfaces-sessions', async ({ app, page, log }) => {
  const root = writeSurfacesRepo();
  const sidA = await openSession(page, { path: root });
  const expectBackgroundOpen = backgroundOpener(page, log);

  phase('replay a.ts pinned, b.ts in the background');
  await replayPinnedAWithBackgroundB(page);

  phase('S9 oversize diff notice');
  await page.locator('.rtab', { hasText: 'Changes' }).first().click();
  await changeRow(page, 'big.txt').first().waitFor({ state: 'visible', timeout: 15000 });
  await changeRow(page, 'big.txt').first().click();
  assert(
    await waitActive(page, 'big.txt (Working Tree)', 15000),
    'S9: the big.txt diff tab never became active',
  );
  const openFileBtn = page.locator('.viewer__notice-action', { hasText: 'Open file' }).first();
  await openFileBtn.waitFor({ state: 'visible', timeout: 15000 });
  await expectBackgroundOpen(
    'S9 oversize notice "Open file"',
    openFileBtn,
    'big.txt',
    'Opened big.txt in a background tab',
  );

  phase('AC-13 cross-session');
  // B's root nests inside A's, so A's palette lists zproj/z.ts while resolveOwningSession
  // hands it to B (longest ancestor).
  const sidB = await openSession(page, { path: `${root}/zproj` });
  await page.waitForFunction(
    (id) =>
      document.querySelector('.session.session--active')?.getAttribute('data-sessionid') === id,
    sidB,
    { timeout: 10000 },
  );
  const bName = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.name ?? null,
    sidB,
  );
  assert(bName, 'AC-13: session B has no name in window.__sessions');
  await selectSession(page, sidA);
  // A's strip can paint a frame before its remembered doc is restored; the baseline must be the
  // settled strip, with A's last active doc (the S9 diff) back on top.
  assert(
    await waitActive(page, 'big.txt (Working Tree)', 10000),
    "AC-13: A's strip did not come back with its remembered doc after switching to A",
  );

  const aTabsBefore = await tabInfo(page);
  await openPalette(page, 'z.ts');
  await paletteRow(page, 'zproj/z.ts').waitFor({ state: 'visible', timeout: 15000 });
  {
    const before = await snapshotUnchanged(page);
    await middleClickJitter(page, paletteRow(page, 'zproj/z.ts'));
    const status = `Opened z.ts in a background tab in ${bName}`;
    const announced = await waitStatus(page, status, 8000)
      .then(() => true)
      .catch(() => false);
    assert(
      announced,
      `AC-13: status should read "${status}", got ${JSON.stringify(await statusText(page))}`,
    );
    const aTabs = await tabInfo(page);
    assert(
      fmt(aTabs) === fmt(aTabsBefore),
      `AC-13: A's strip changed ${fmt(aTabsBefore)} → ${fmt(aTabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `AC-13: state changed — ${diff}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });

  await selectSession(page, sidB);
  const zOpen = await waitTab(page, 'z.ts')
    .then(() => true)
    .catch(() => false);
  assert(zOpen, `AC-13: B's strip has no z.ts tab; tabs ${fmt(await tabInfo(page))}`);
  const bTabs = await tabInfo(page);
  const zTab = bTabs.find((t) => t.title === 'z.ts');
  assert(!zTab.preview, 'AC-13: z.ts must be pinned in B');
  assert(
    !bTabs.some((t) => t.active),
    `AC-13: B's remembered active doc (the terminal) must not change; tabs ${fmt(bTabs)}`,
  );
  log(`AC-13 cross-session: z.ts landed pinned in "${bName}", A untouched ✓`);

  phase('AC-4 background match opens at its line');
  await selectSession(page, sidA);
  const bBack = await waitTab(page, 'b.ts')
    .then(() => true)
    .catch(() => false);
  assert(bBack, "AC-4: b.ts is missing from A's strip after switching back");
  await page
    .locator('.tabbar [role="tab"]', { has: page.locator('span', { hasText: exact('b.ts') }) })
    .first()
    .click();
  assert(await waitActive(page, 'b.ts', 15000), 'AC-4: b.ts never became active');
  assert(
    await waitCursor(page, B_TOKEN_LINE, 15000),
    `AC-4: activating b.ts should land on its match line ${B_TOKEN_LINE}, got ${JSON.stringify(await editorState(page))}`,
  );
  log(`AC-4 b.ts opens at line ${B_TOKEN_LINE} when first activated ✓`);

  await closeApp(app, page);
});

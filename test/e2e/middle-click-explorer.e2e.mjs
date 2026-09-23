/**
 * Middle-click in the explorer opens a background tab (spec 2026-09-22-middle-click-new-tab §7:
 * AC-1, 2, 3, 6, 9, 11, 14, 15), plus a middle-click CLOSE on an overflowing tab strip (row T):
 * both are the autoscroll-eats-auxclick defect (spec C2), which only shows with pointer jitter in a
 * container that can scroll, so the tree and the strip are made to overflow first.
 */

import { assert, closeApp, openSession, runScenario } from './harness.mjs';
import {
  middleClickJitter,
  sameSnapshot,
  snapshotUnchanged,
  tabInfo,
  waitStatus,
  waitTab,
  watchStatus,
  writeFixtureRepo,
} from './middle-click-fixture.mjs';

const files = { 'dir1/inner.ts': 'export const inner = 1;\n' };
for (const n of ['a', 'b', 'ba', 'bb', 'bc', 'c', 'd', 'e', 'f'])
  files[`${n}.ts`] = `export const ${n} = 1;\n`;
for (let i = 0; i < 60; i++) files[`f${String(i).padStart(2, '0')}.txt`] = `filler ${i}\n`;

const tabCount = async (page) => (await tabInfo(page)).length;

runScenario('middle-click-explorer', async ({ app, page, log }) => {
  const root = writeFixtureRepo({ files });
  await openSession(page, { path: root });
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  const row = (name) =>
    page.locator('.filerow', {
      has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
    });
  const tab = (title) => page.locator('.tabbar [role="tab"]', { hasText: title }).first();
  const treeOverflows = await page.evaluate(() => {
    const t = document.querySelector('[role="tree"]');
    return !!t && t.scrollHeight > t.clientHeight + 1;
  });
  assert(treeOverflows, 'fixture must make the explorer tree overflow (spec AC-1)');

  await row('a.ts').first().dblclick();
  await waitTab(page, 'a.ts');
  await page.waitForSelector('.monaco-editor', { timeout: 15000 });
  await page.locator('.monaco-editor').first().click();
  await watchStatus(page);

  // AC-1
  let before = await snapshotUnchanged(page);
  await middleClickJitter(page, row('e.ts').first());
  const e = await waitTab(page, 'e.ts');
  assert(!e.active, 'AC-1: e.ts must open in the background, not become active');
  assert(!e.preview, 'AC-1: a middle-clicked file opens pinned, not as the preview');
  let diff = sameSnapshot(before, await snapshotUnchanged(page));
  assert(diff === null, `AC-1: a background open changed: ${diff}`);
  await waitStatus(page, 'Opened e.ts in a background tab');
  log('AC-1 explorer middle-click → pinned background tab, nothing else moved ✓');

  // AC-3 + AC-15 (cue present, then gone within 1 s)
  const count = await tabCount(page);
  await page.waitForFunction(() => !document.querySelector('.tabbar .tab--flash'), null, {
    timeout: 2000,
  });
  await row('e.ts').first().click({ button: 'middle' });
  // Poll on a timer: the hidden window's frames are throttled, and a 600 ms cue can fall between two.
  const flashedTitle = await (
    await page.waitForFunction(
      () => document.querySelector('.tabbar .tab--flash span')?.textContent ?? null,
      null,
      { timeout: 3000, polling: 50 },
    )
  ).jsonValue();
  assert(flashedTitle === 'e.ts', `AC-3: the cue must land on e.ts (got ${flashedTitle})`);
  await page.waitForFunction(() => !document.querySelector('.tabbar .tab--flash'), null, {
    timeout: 1000,
    polling: 50,
  });
  assert((await tabCount(page)) === count, 'AC-3: an already-open file adds no tab');
  await waitStatus(page, 'e.ts is already open');
  log('AC-3 already-open → no tab, cue then cleared, announced ✓');

  // AC-14: identical announcements are separated by a clear, so each is re-read
  await page.evaluate(() => {
    window.__statusLog = [];
  });
  await row('e.ts').first().click({ button: 'middle' });
  await page.waitForTimeout(150);
  await row('e.ts').first().click({ button: 'middle' });
  await page.waitForFunction(
    () => window.__statusLog.filter((t) => t === 'e.ts is already open').length >= 2,
    null,
    { timeout: 3000 },
  );
  const logEntries = await page.evaluate(() => window.__statusLog);
  const firstMsg = logEntries.indexOf('e.ts is already open');
  const secondMsg = logEntries.indexOf('e.ts is already open', firstMsg + 1);
  assert(
    logEntries.slice(firstMsg + 1, secondMsg).includes(''),
    `AC-14: the region must be cleared between identical messages (log ${JSON.stringify(logEntries)})`,
  );
  log('AC-14 repeated announcement cleared in between ✓');

  // AC-2: the preview tab gets pinned in place, not replaced or moved
  await row('d.ts').first().click();
  const d0 = await waitTab(page, 'd.ts');
  assert(d0.preview, 'AC-2 setup: single-click must open d.ts as the preview');
  await tab('a.ts').click();
  await page.locator('.monaco-editor').first().click();
  const idxBefore = (await tabInfo(page)).findIndex((t) => t.title === 'd.ts');
  const countBefore = await tabCount(page);
  before = await snapshotUnchanged(page);
  await middleClickJitter(page, row('d.ts').first());
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('.tabbar [role="tab"]'))
        .find((el) => el.querySelector('span')?.textContent === 'd.ts')
        ?.classList.contains('tab--preview'),
    null,
    { timeout: 5000 },
  );
  const tabsAfter = await tabInfo(page);
  assert(
    tabsAfter.findIndex((t) => t.title === 'd.ts') === idxBefore,
    'AC-2: d.ts keeps its index',
  );
  assert(tabsAfter.length === countBefore, 'AC-2: pinning the preview adds no tab');
  diff = sameSnapshot(before, await snapshotUnchanged(page));
  assert(diff === null, `AC-2: pinning the preview changed: ${diff}`);
  await waitStatus(page, 'Pinned d.ts');
  log('AC-2 preview pinned in place ✓');

  // AC-6: a folder gets no action and does not toggle
  const expanded0 = await row('dir1').first().getAttribute('aria-expanded');
  const c6 = await tabCount(page);
  await middleClickJitter(page, row('dir1').first());
  await page.waitForTimeout(400);
  assert(
    (await row('dir1').first().getAttribute('aria-expanded')) === expanded0,
    'AC-6: middle-click must not expand/collapse a folder',
  );
  assert((await tabCount(page)) === c6, 'AC-6: middle-click on a folder opens nothing');
  log('AC-6 folder middle-click is a no-op ✓');

  // AC-11: press on one row, release on another → nothing, and no drag starts
  await page.evaluate(() => {
    window.__dragstarts = 0;
    document.addEventListener('dragstart', () => {
      window.__dragstarts += 1;
    });
  });
  const c11 = await tabCount(page);
  const bBox = await row('b.ts').first().boundingBox();
  const gBox = await row('c.ts').first().boundingBox();
  await page.mouse.move(bBox.x + 30, bBox.y + bBox.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(gBox.x + 30, gBox.y + gBox.height / 2, { steps: 10 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(400);
  assert((await tabCount(page)) === c11, 'AC-11: a middle drag across rows opens nothing');
  assert(
    (await page.evaluate(() => window.__dragstarts)) === 0,
    'AC-11: a middle drag must not start a drag',
  );
  log('AC-11 middle drag opens nothing, no dragstart ✓');

  // AC-15: the cue has no animation under either reduced-motion switch, and an outline under
  // forced colors
  const flashStyle = () =>
    page.waitForFunction(
      () => {
        const el = document.querySelector('.tabbar .tab--flash');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { animation: cs.animationName, outline: cs.outlineStyle };
      },
      null,
      { timeout: 3000, polling: 50 },
    );
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'true';
  });
  await row('f00.txt').first().click({ button: 'middle' });
  let st = await (await flashStyle()).jsonValue();
  assert(
    st.animation === 'none',
    `AC-15: data-reduce-motion must stop the animation (${st.animation})`,
  );
  assert(st.outline !== 'none', 'AC-15: reduced motion keeps a static outline');
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'false';
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await row('f01.txt').first().click({ button: 'middle' });
  st = await (await flashStyle()).jsonValue();
  assert(
    st.animation === 'none',
    `AC-15: prefers-reduced-motion must stop the animation (${st.animation})`,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' });
  await row('f02.txt').first().click({ button: 'middle' });
  st = await (await flashStyle()).jsonValue();
  assert(st.outline !== 'none', 'AC-15: forced colors must show an outline cue');
  await page.emulateMedia({ forcedColors: 'none' });
  log('AC-15 cue honours reduced motion and forced colors ✓');

  // AC-9: background opens are not navigations, so Back skips them
  await row('f.ts').first().dblclick();
  await page.waitForFunction(
    () => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === 'f.ts',
    null,
    { timeout: 10000 },
  );
  for (const n of ['ba.ts', 'bb.ts', 'bc.ts']) {
    await row(n).first().click({ button: 'middle' });
    await waitTab(page, n);
  }
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(
    () => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === 'a.ts',
    null,
    { timeout: 10000 },
  );
  log('AC-9 Back lands before the last foreground open, not on a background tab ✓');

  // QA finding 2: a virtual-window shift between press and release (a reveal scroll, a tree
  // refresh) must not replace the pressed row's element — Chromium fires no auxclick/click when
  // it is. Shift the window away and back while the button is held; the row stays put under the
  // pointer, so only element identity decides whether the click lands.
  const tree = page.locator('[role="tree"]');
  const rowH = (await row('a.ts').first().boundingBox()).height;
  const scrollTree = (top) =>
    tree.evaluate((t, v) => {
      t.scrollTop = v;
    }, top);
  const settle = () => page.waitForTimeout(400);
  await scrollTree(rowH * 25);
  await settle();
  const pressAcrossShift = async (button) => {
    const target = await tree.evaluate((t) => {
      const r = t.getBoundingClientRect();
      const el = document
        .elementFromPoint(r.left + 40, r.top + r.height / 2)
        ?.closest('.filerow[data-path]');
      if (!el) return null;
      el.dataset.probe = 'pressed';
      return {
        name: el.querySelector('.filerow__name')?.textContent ?? '',
        x: r.left + 40,
        y: r.top + r.height / 2,
      };
    });
    assert(target, 'shift probe: no row under the tree centre');
    await page.mouse.move(target.x, target.y);
    await page.mouse.down({ button });
    const top = await tree.evaluate((t) => t.scrollTop);
    await scrollTree(top + rowH * 3);
    await settle();
    await scrollTree(top);
    await settle();
    const sameElement = await page.evaluate(
      () => !!document.querySelector('.filerow[data-probe="pressed"]'),
    );
    await page.mouse.up({ button });
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-probe]')) delete el.dataset.probe;
    });
    return { ...target, sameElement };
  };
  const mid = await pressAcrossShift('middle');
  const midTab = await waitTab(page, mid.name, 5000)
    .then((t) => t)
    .catch(() => null);
  log(`shift probe (middle) on ${mid.name}: same element=${mid.sameElement} tab=${!!midTab}`);
  await scrollTree(rowH * 32);
  await settle();
  const left = await pressAcrossShift('left');
  const leftOpened = await waitTab(page, left.name, 5000)
    .then(() => true)
    .catch(() => false);
  log(`shift probe (left) on ${left.name}: same element=${left.sameElement} opened=${leftOpened}`);
  assert(mid.sameElement, 'shift probe: a window shift replaced the pressed row element');
  assert(
    midTab && !midTab.active,
    `shift probe: middle-click across a window shift opened nothing`,
  );
  assert(leftOpened, 'shift probe: left-click across a window shift opened nothing');
  await tab('a.ts').click();
  await scrollTree(0);
  await settle();
  log('a row pressed across a virtual-window shift keeps its element; middle and left land ✓');

  // Row T: middle-click still closes a tab when the strip overflows
  for (let i = 3; i < 40; i++) {
    if (
      await page.evaluate(() => {
        const s = document.querySelector('.tabbar');
        return s.scrollWidth > s.clientWidth + 1;
      })
    )
      break;
    const name = `f${String(i).padStart(2, '0')}.txt`;
    if ((await row(name).count()) === 0) continue;
    await row(name).first().click({ button: 'middle' });
    await waitTab(page, name);
  }
  const overflowing = await page.evaluate(() => {
    const s = document.querySelector('.tabbar');
    return s.scrollWidth > s.clientWidth + 1;
  });
  assert(overflowing, 'row T setup: the tab strip must overflow');
  const victim = await page.evaluate(() => {
    const strip = document.querySelector('.tabbar').getBoundingClientRect();
    const t = Array.from(document.querySelectorAll('.tabbar [role="tab"]')).find((el) => {
      const r = el.getBoundingClientRect();
      return (
        !el.classList.contains('tab--active') && r.left >= strip.left && r.right <= strip.right
      );
    });
    return t?.querySelector('span')?.textContent ?? null;
  });
  assert(victim, 'row T setup: a fully visible inactive tab exists');
  await middleClickJitter(page, tab(victim));
  const closed = await page
    .waitForFunction(
      (t) =>
        !Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
          (el) => el.querySelector('span')?.textContent === t,
        ),
      victim,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(closed, `row T: middle-click did not close ${victim} on an overflowing strip`);
  log(`row T middle-click closes ${victim} on an overflowing strip ✓`);

  // Palette Recent rows (empty query): the just-closed file comes back in the background and
  // the palette stays open for more.
  const activeBeforeRecent = (await tabInfo(page)).find((t) => t.active)?.title;
  await page.click('.omnibar');
  await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
  const recentRow = page
    .locator('.palette__group', {
      has: page.locator('.palette__gtitle', { hasText: /^Recent$/ }),
    })
    .locator('.palette__row', {
      has: page.locator('.palette__title', {
        hasText: new RegExp(`^${victim.replace('.', '\\.')}$`),
      }),
    })
    .first();
  await recentRow.waitFor({ state: 'visible', timeout: 10000 });
  await middleClickJitter(page, recentRow);
  const reopened = await waitTab(page, victim)
    .then((t) => t)
    .catch(() => null);
  assert(reopened, `palette Recent: middle-click did not reopen ${victim}`);
  assert(
    !reopened.active && !reopened.preview,
    'palette Recent: must reopen pinned, in the background',
  );
  assert(
    (await tabInfo(page)).find((t) => t.active)?.title === activeBeforeRecent,
    'palette Recent: the active tab changed',
  );
  assert(
    await page.locator('.palette__input').isVisible(),
    'palette Recent: the palette must stay open after a middle-click',
  );
  await page.keyboard.press('Escape');
  log(`palette Recent row: ${victim} reopened in the background, palette stayed open ✓`);

  await closeApp(app, page);
});

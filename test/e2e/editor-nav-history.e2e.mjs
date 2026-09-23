/**
 * Editor navigation history, code-jump flows (docs/specs/2026-09-22-editor-nav-history.md §7):
 * AC1 cross-file goto round trip, AC11 applying never records, AC13 every Back input, AC15 focus +
 * announcement, AC7 a closed file reopens as a preview tab.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs editor-nav-history` (the filter is a
 * substring, so that also runs the -moves and -lifecycle files).
 */

import { assert, openSession, runScenario } from './harness.mjs';
import {
  activeTab,
  announcement,
  clickLine,
  clickTerminalTab,
  cursorLine,
  hasTab,
  isPreview,
  lineVisible,
  makeNavFixture,
  navDisabled,
  openAtLineViaSearch,
  openViaTree,
  tapIndex,
  waitActive,
  waitCursor,
  waitForIndexReady,
} from './nav-history-fixture.mjs';

runScenario('editor-nav-history', async ({ app, page, log }) => {
  const root = makeNavFixture(['u.ts']);
  await tapIndex(page);
  await openSession(page, { path: root });
  await waitForIndexReady(page, log);

  const launch = await navDisabled(page);
  assert(
    launch.back && launch.forward,
    `at launch both buttons disabled, got ${JSON.stringify(launch)}`,
  );
  log('AC13 launch: Back/Forward disabled ✓');

  const expectAt = async (title, line, what) => {
    assert(
      await waitActive(page, title),
      `${what}: expected ${title} active, got ${await activeTab(page)}`,
    );
    if (line !== undefined) {
      assert(
        await waitCursor(page, line),
        `${what}: expected ${title} cursor ${line}, got ${await cursorLine(page)}`,
      );
    }
  };

  // AC1
  await openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12);
  await page.keyboard.press('F12');
  await expectAt('b.ts', 40, 'AC1 F12');
  const afterOne = await navDisabled(page);
  assert(
    !afterOne.back && afterOne.forward,
    `AC13 after one nav at tip: Back enabled, Forward disabled, got ${JSON.stringify(afterOne)}`,
  );
  await page.keyboard.press('Alt+ArrowLeft');
  await expectAt('a.ts', 12, 'AC1 Alt+Left');
  assert(await lineVisible(page, 12), 'AC1: line 12 should be visible after Back');
  assert(
    (await announcement(page)) === 'Editor: a.ts, line 12',
    `AC15 announcement, got "${await announcement(page)}"`,
  );
  await page.keyboard.press('Alt+ArrowRight');
  await expectAt('b.ts', 40, 'AC1 Alt+Right');
  log('AC1 cross-file goto round trip ✓');

  // AC11
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Alt+ArrowLeft');
    await expectAt('a.ts', 12, `AC11 loop ${i} back`);
    await page.keyboard.press('Alt+ArrowRight');
    await expectAt('b.ts', 40, `AC11 loop ${i} forward`);
  }
  assert((await navDisabled(page)).forward, 'AC11: Forward disabled at b.ts after the loop');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectAt('a.ts', 12, 'AC11 single back');
  assert((await navDisabled(page)).back, 'AC11: a second Back is disabled (no entries were added)');
  await page.keyboard.press('Alt+ArrowRight');
  await expectAt('b.ts', 40, 'AC11 return');
  log('AC11 applying records nothing ✓');

  // AC13
  const inputs = [
    ['top-bar Back button', () => page.click('button[title="Back"]')],
    [
      'palette "Go back"',
      async () => {
        await page.keyboard.press('Control+Shift+P');
        await page.waitForSelector('.palette', { state: 'visible', timeout: 5000 });
        await page.keyboard.type('Go back');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
      },
    ],
    process.platform === 'win32'
      ? [
          'Windows app-command',
          () =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].emit(
                'app-command',
                { preventDefault() {} },
                'browser-backward',
              ),
            ),
        ]
      : [
          'auxclick button 3',
          () =>
            page.evaluate(() =>
              document.body.dispatchEvent(
                new MouseEvent('auxclick', { button: 3, bubbles: true, cancelable: true }),
              ),
            ),
        ],
  ];
  for (const [name, fire] of inputs) {
    await fire();
    await expectAt('a.ts', 12, `AC13 ${name}`);
    await page.keyboard.press('Alt+ArrowRight');
    await expectAt('b.ts', 40, `AC13 ${name} return`);
    log(`AC13 ${name} ✓`);
  }
  const atTip = await navDisabled(page);
  assert(!atTip.back && atTip.forward, `AC13 at tip, got ${JSON.stringify(atTip)}`);

  // AC15 focus
  await clickTerminalTab(page);
  await page.locator('.termhost:visible .xterm-helper-textarea').first().focus();
  await page.click('button[title="Back"]');
  // Back from the Terminal tab first returns to the doc that was open (spec §2.3 step 1).
  await expectAt('b.ts', 40, 'AC15 Back from terminal');
  const editorFocused = await page
    .waitForFunction(() => !!document.activeElement?.closest('.monaco-editor'), null, {
      timeout: 5000,
    })
    .then(() => true)
    .catch(() => false);
  assert(editorFocused, 'AC15: the editor has focus after Back from a focused terminal');
  assert(
    (await announcement(page)) === 'Editor: b.ts, line 40',
    `AC15 announcement after button Back, got "${await announcement(page)}"`,
  );
  await page.click('button[title="Back"]');
  await expectAt('a.ts', 12, 'AC15 second Back');
  assert(
    (await announcement(page)) === 'Editor: a.ts, line 12',
    `AC15 announcement after the second Back, got "${await announcement(page)}"`,
  );
  log('AC15 focus + announcement ✓');

  // AC7
  await page.keyboard.press('Alt+ArrowRight');
  await expectAt('b.ts', 40, 'AC7 forward');
  if (await hasTab(page, 'a.ts')) {
    await page
      .locator('.tabbar [role="tab"]', { hasText: 'a.ts' })
      .first()
      .click({ button: 'middle' });
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
          (el) => el.querySelector('span')?.textContent === 'a.ts',
        ),
      null,
      { timeout: 10000 },
    );
  }
  assert(!(await hasTab(page, 'a.ts')), 'AC7: a.ts tab is closed before Back');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectAt('a.ts', 12, 'AC7 reopen');
  assert(await isPreview(page, 'a.ts'), 'AC7: the reopened a.ts is a preview tab');
  log('AC7 closed file reopens as preview at line 12 ✓');

  // An Undo's content event arrives after its cursor event; it must not taint the next move, so a
  // same-file F12 right after an Undo is still a recorded jump.
  await openViaTree(page, root, ['u.ts']);
  assert(await waitActive(page, 'u.ts'), `undo: u.ts opens, got ${await activeTab(page)}`);
  await clickLine(page, 5);
  assert(await waitCursor(page, 5), `undo: cursor on u.ts:5, got ${await cursorLine(page)}`);
  await page.keyboard.type('x');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => {
      const ed = (window.monaco?.editor.getEditors() ?? []).find((e) => e.hasTextFocus());
      return ed?.getModel()?.getLineContent(5) === 'localTarget();';
    },
    null,
    { timeout: 5000 },
  );
  await page.keyboard.press('F12');
  await expectAt('u.ts', 60, 'undo: same-file F12');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectAt('u.ts', 5, 'undo: Back after F12 following an Undo');
  log('an Undo does not swallow the next same-file jump ✓');
});

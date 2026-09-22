/**
 * Editor navigation history, session/tab lifecycle (docs/specs/2026-09-22-editor-nav-history.md
 * §7): AC3 session switches are not entries, AC4 the Terminal tab is not an entry, AC8 a deleted
 * file is skipped, AC14 Back from the Board shows the editor, and — on a second, fresh app — AC9 a
 * cross-session entry and AC10 a dead session is skipped.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs editor-nav-history-lifecycle`.
 */

import { unlinkSync } from 'node:fs';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  activeSessionId,
  activeTab,
  clickTerminalTab,
  freshApp,
  hasTab,
  makeNavFixture,
  navDisabled,
  openViaTree,
  selectSession,
  waitActive,
} from './nav-history-fixture.mjs';

async function openFile(page, root, name) {
  await openViaTree(page, root, [name]);
  assert(await waitActive(page, name), `${name} should be active after a tree open`);
}

async function closeTab(page, title) {
  await page
    .locator('.tabbar [role="tab"]', { hasText: title })
    .first()
    .click({ button: 'middle' });
  await page.waitForFunction(
    (want) =>
      !Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (el) => el.querySelector('span')?.textContent === want,
      ),
    title,
    { timeout: 10000 },
  );
}

runScenario('editor-nav-history-lifecycle', async ({ page, log }) => {
  const root = makeNavFixture([
    'l4a.ts',
    'l4b.ts',
    'l8a.ts',
    'l8b.ts',
    'l8c.ts',
    'l14a.ts',
    'l14b.ts',
  ]);
  const s1 = await openSession(page, { path: root });
  const s2 = await openSession(page, { path: root });
  const expectActive = async (title, what) =>
    assert(
      await waitActive(page, title),
      `${what}: expected ${title}, got ${await activeTab(page)}`,
    );

  // AC3
  assert((await navDisabled(page)).back, 'AC3: Back disabled with two sessions and no docs');
  await selectSession(page, s1);
  await openFile(page, root, 'a.ts');
  await selectSession(page, s2);
  await selectSession(page, s1);
  assert(
    (await navDisabled(page)).back,
    'AC3: Back still disabled after S1 → S2 → S1 via the sidebar (one entry: a.ts)',
  );
  await openFile(page, root, 'b.ts');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('a.ts', 'AC3 Back');
  assert((await activeSessionId(page)) === s1, 'AC3: Back stays in S1');
  assert((await navDisabled(page)).back, 'AC3: no terminal or S2 stop was recorded before a.ts');
  log('AC3 session switches are not entries ✓');

  // AC4
  await openFile(page, root, 'l4a.ts');
  await clickTerminalTab(page);
  await openFile(page, root, 'l4b.ts');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('l4a.ts', 'AC4 Back');
  log('AC4 the Terminal tab is not an entry ✓');

  // AC8
  await openFile(page, root, 'l8a.ts');
  await openFile(page, root, 'l8b.ts');
  await openFile(page, root, 'l8c.ts');
  await closeTab(page, 'l8b.ts');
  unlinkSync(`${root}/l8b.ts`);
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('l8a.ts', 'AC8 Back skips the deleted file');
  await page.keyboard.press('Alt+ArrowRight');
  await expectActive('l8c.ts', 'AC8 Forward skips the deleted file');
  assert(!(await hasTab(page, 'l8b.ts')), 'AC8: the deleted file was not reopened');
  log('AC8 a deleted file is skipped ✓');

  // AC14
  await openFile(page, root, 'l14a.ts');
  await openFile(page, root, 'l14b.ts');
  await page.click('.viewswitch__btn[title="Feature Board"]');
  await page.waitForSelector('.viewswitch__btn[title="Feature Board"][aria-selected="true"]', {
    timeout: 5000,
  });
  await page.keyboard.press('Alt+ArrowLeft');
  const editorShown = await page
    .waitForSelector('.viewswitch__btn[title="Editor"][aria-selected="true"]', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(editorShown, 'AC14: Back from the Board switches the center view to the editor');
  await expectActive('l14a.ts', 'AC14 Back');
  log('AC14 Back from the Board shows the editor ✓');

  // AC9 + AC10 need an empty history: a second app.
  const second = await freshApp();
  const p2 = second.page;
  try {
    const root2 = makeNavFixture();
    const t1 = await openSession(p2, { path: root2 });
    const t2 = await openSession(p2, { path: root2 });
    await selectSession(p2, t1);
    await openFile(p2, root2, 'b.ts');
    await openFile(p2, root2, 'a.ts');
    await selectSession(p2, t2);
    await openFile(p2, root2, 'c.ts');
    await p2.keyboard.press('Alt+ArrowLeft');
    assert(await waitActive(p2, 'a.ts'), `AC9: Back lands on a.ts, got ${await activeTab(p2)}`);
    assert((await activeSessionId(p2)) === t1, 'AC9: Back switches to S1');
    log('AC9 cross-session entry ✓');

    await p2.keyboard.press('Alt+ArrowRight');
    assert(await waitActive(p2, 'c.ts'), `AC10: Forward lands on c.ts, got ${await activeTab(p2)}`);
    await p2.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), t1);
    await p2.waitForFunction((id) => !(window.__sessions || []).some((s) => s.id === id), t1, {
      timeout: 15000,
    });
    await p2.waitForTimeout(300);
    if (!(await navDisabled(p2)).back) {
      await p2.keyboard.press('Alt+ArrowLeft');
      await p2.waitForTimeout(800);
    }
    const landed = await activeTab(p2);
    assert(landed !== 'a.ts' && landed !== 'b.ts', `AC10: never lands on an S1 doc, got ${landed}`);
    assert((await activeSessionId(p2)) === t2, 'AC10: still in S2');
    log('AC10 a dead session is skipped ✓');
  } finally {
    await second.cleanup();
  }
});

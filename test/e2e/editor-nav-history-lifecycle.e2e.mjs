/**
 * Editor navigation history, session/tab lifecycle (docs/specs/2026-09-22-editor-nav-history.md
 * §7): AC3 session switches are not entries, AC4 the Terminal tab is not an entry, Back from the
 * Terminal tab lands on the doc that was open, AC8 a deleted file is skipped, AC14 Back from the
 * Board shows the editor; on a second app AC9 a cross-session entry (announced with its line) and
 * AC10 a dead session is skipped; on a third, Back never lands on the doc already on screen.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs editor-nav-history-lifecycle`.
 */

import { unlinkSync } from 'node:fs';
import { closeAllDocs } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  activeSessionId,
  activeTab,
  announcement,
  clickLine,
  clickTerminalTab,
  cursorLine,
  freshApp,
  hasTab,
  makeNavFixture,
  navDisabled,
  openViaTree,
  selectSession,
  waitActive,
  waitCursor,
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
    'l6a.ts',
    'l6b.ts',
    'o1.ts',
    'o2.ts',
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
  await expectActive('a.ts', 'AC3: S1 shows a.ts again');
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

  // Back from the Terminal tab returns to the doc that was open, not the one before it (§2.3).
  await openFile(page, root, 'l6a.ts');
  await openFile(page, root, 'l6b.ts');
  await clickTerminalTab(page);
  assert(!(await navDisabled(page)).back, 'Back is enabled on the Terminal tab');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('l6b.ts', 'Back from the Terminal tab');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('l6a.ts', 'second Back from the Terminal tab');
  log('Back from the Terminal tab lands on the doc that was open ✓');

  // AC8. Earlier sections' tabs are closed first: with nine tabs the strip overflows in the hidden
  // window and a middle-click on a clipped tab does not reach it. Closed files stay history entries.
  await closeAllDocs(page);
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
  await expectActive('l14b.ts', 'AC14 Back lands on the doc behind the Board');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('l14a.ts', 'AC14 second Back');
  log('AC14 Back from the Board shows the editor ✓');

  // A doc reopened from another session moves to it (one owner), so its two recordings are one
  // place: Back from it must go on to the entry before, never re-land on the doc on screen.
  await openFile(page, root, 'o1.ts');
  await selectSession(page, s2);
  await openFile(page, root, 'o1.ts');
  await openFile(page, root, 'o2.ts');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('o1.ts', 'owner transfer: Back to o1.ts');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('l14a.ts', 'owner transfer: the next Back leaves o1.ts');
  log('a doc that changed session is one history place ✓');

  // AC9 + AC10 need an empty history: a second app.
  const second = await freshApp();
  const p2 = second.page;
  try {
    const root2 = makeNavFixture();
    const t1 = await openSession(p2, { path: root2 });
    const t2 = await openSession(p2, { path: root2 });
    await selectSession(p2, t1);
    await openFile(p2, root2, 'b.ts');
    // A single-click (preview) open records a.ts once, with no position; the cursor then moves
    // without recording, so the entry is left by the session switch with no `pos` (§2.3 step 6).
    await p2
      .locator('.filerow', { has: p2.locator('.filerow__name', { hasText: /^a\.ts$/ }) })
      .first()
      .click();
    assert(
      await waitActive(p2, 'a.ts'),
      `AC9: a.ts opens as a preview, got ${await activeTab(p2)}`,
    );
    await p2.waitForFunction(() => (window.monaco?.editor.getEditors() ?? []).length > 0, null, {
      timeout: 15000,
    });
    await clickLine(p2, 5);
    assert(await waitCursor(p2, 5), `AC9: cursor to a.ts:5, got ${await cursorLine(p2)}`);
    await selectSession(p2, t2);
    await openFile(p2, root2, 'c.ts');
    await p2.keyboard.press('Alt+ArrowLeft');
    assert(await waitActive(p2, 'a.ts'), `AC9: Back lands on a.ts, got ${await activeTab(p2)}`);
    assert((await activeSessionId(p2)) === t1, 'AC9: Back switches to S1');
    assert(
      (await announcement(p2)) === 'Editor: a.ts, line 5',
      `AC9: an entry left by a session switch still announces its line, got "${await announcement(p2)}"`,
    );
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

  // After a kill, Back must not "land" on the doc already showing (§2.3 step 1).
  const third = await freshApp();
  const p3 = third.page;
  try {
    const root3 = makeNavFixture();
    const u1 = await openSession(p3, { path: root3 });
    const u2 = await openSession(p3, { path: root3 });
    await selectSession(p3, u2);
    await openFile(p3, root3, 'c.ts');
    await selectSession(p3, u1);
    await openFile(p3, root3, 'a.ts');
    await selectSession(p3, u2);
    assert(await waitActive(p3, 'c.ts'), `S2 shows c.ts again, got ${await activeTab(p3)}`);
    await p3.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), u1);
    await p3.waitForFunction((id) => !(window.__sessions || []).some((s) => s.id === id), u1, {
      timeout: 15000,
    });
    await p3.waitForTimeout(300);
    assert(
      (await navDisabled(p3)).back,
      'after the kill the only live entry is the doc on screen, so Back is disabled',
    );
    log('Back never lands on the location already on screen ✓');
  } finally {
    await third.cleanup();
  }
});

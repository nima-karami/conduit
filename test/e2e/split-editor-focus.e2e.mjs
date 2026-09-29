/**
 * split-editor-focus — where keyboard focus lands after a user activation
 * (docs/specs/2026-09-28-split-editor.md §10 focus management). Each step asserts
 * `document.activeElement`, not just which tab is active, and a Ctrl+Tab landing proves a typed
 * character reaches the editor:
 *   CT  Ctrl+Tab file → file (and the typed character lands), file → diff (the modified editor),
 *       and Ctrl+PageUp → the Terminal
 *   TC  a tab click
 *   TT  a pointer click on the Terminal button leaves focus out of xterm (main's behaviour)
 *   CW  the Ctrl+W successor
 *   PT  the palette entry is titled "Split Editor Right"
 *   SR  Split Right on rendered markdown, and on a PDF
 *   MV  Move to Other Group with a `.ts` left behind in the left group
 *   SB  each strip's split button: the left one is enabled on a doc even with the right group
 *       active (clicking it splits from the left), the right one is at the cap, and a strip on
 *       the Terminal is disabled
 *   E6  Close Editor Group while the left group shows the Terminal
 *   XT  a × close landing on the Terminal leaves focus out of xterm (as TT)
 * Failures are collected, so one run reports every step that misses.
 */

import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeRow, commitBase, installTabHelpers } from './changes-fixture.mjs';
import { assert, openChangesTab, openSession, REPO, runScenario } from './harness.mjs';
import {
  explorer,
  G,
  openFromExplorer,
  same,
  sleep,
  tabOf,
  waitShown,
} from './split-editor-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'conduit-split-focus-'));
writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
writeFileSync(join(root, 'c.ts'), 'export const c = 3;\n');
writeFileSync(join(root, 'd.txt'), 'one\ntwo\n');
writeFileSync(join(root, 'note.md'), '# Note\n\nhello\n');
copyFileSync(join(REPO, 'test', 'e2e', 'fixtures', 'sample.pdf'), join(root, 'one.pdf'));
commitBase(root);
writeFileSync(join(root, 'd.txt'), 'one\nTWO changed\n');

/** What holds focus: its group, and which view inside it. */
const focusNow = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    const group = a?.closest('.editor-group')?.getAttribute('data-group') ?? null;
    const editors = (window.monaco?.editor.getEditors() ?? []).filter((e) => e.hasTextFocus());
    let view = a ? a.tagName.toLowerCase() : 'none';
    if (a?.closest('.xterm')) view = 'terminal';
    else if (a?.closest('.monaco-diff-editor'))
      view = a.closest('.editor.modified') ? 'diff-modified' : 'diff-original';
    else if (a?.closest('.monaco-editor'))
      view = `editor:${editors[0]?.getModel()?.uri.path.split('/').pop() ?? '?'}`;
    else if (a?.closest('.markdown')) view = 'markdown';
    else if (a?.closest('.pdfview')) view = 'pdf';
    else if (a?.getAttribute('role') === 'tab') view = 'tab';
    else if (a?.classList.contains('editor-group__body')) view = 'group-body';
    return { group, view };
  });

runScenario('split-editor-focus', async ({ page, log }) => {
  const misses = [];
  const splitButtons = () =>
    page.evaluate(
      (sels) =>
        sels.map(
          (s) =>
            document.querySelector(`${s} .tabbar__split`)?.getAttribute('aria-disabled') ?? null,
        ),
      [G(1), G(2)],
    );
  /** Waits for focus to settle on `view` in group `g`, and records a miss if it never does. */
  const expectFocus = async (label, g, view) => {
    const ok = await page
      .waitForFunction(
        ({ sel, v }) => {
          const a = document.activeElement;
          if (!a?.closest(sel)) return false;
          if (v === 'terminal') return !!a.closest('.xterm');
          if (v === 'diff-modified') return !!a.closest('.monaco-diff-editor .editor.modified');
          if (v === 'markdown') return !!a.closest('.markdown');
          if (v === 'pdf') return !!a.closest('.pdfview');
          const name = v.slice('editor:'.length);
          return (window.monaco?.editor.getEditors() ?? []).some(
            (e) =>
              e.hasTextFocus() &&
              e.getDomNode()?.closest(sel) &&
              e.getModel()?.uri.path.endsWith(`/${name}`),
          );
        },
        { sel: G(g), v: view },
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    const at = await focusNow(page);
    log(`${label}: expected group ${g} ${view} · focus is in group ${at.group} ${at.view}`);
    if (!ok) misses.push(`${label}: focus is in group ${at.group} ${at.view}, not ${view}`);
    return ok;
  };
  const clickEditor = async (g) => {
    await page
      .locator(`${G(g)} .monaco-editor .view-lines`)
      .first()
      .click();
    await sleep(150);
  };

  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });
  log('session', sid);
  await installTabHelpers(page);
  await openFromExplorer(page, 'a.ts');
  await openFromExplorer(page, 'b.ts');
  await openFromExplorer(page, 'c.ts');
  await openChangesTab(page);
  await (await changeRow(page, 'Changes', 'd.txt')).dblclick();
  await page.waitForSelector(`${G(1)} .monaco-diff-editor`, { timeout: 15000 });
  await explorer(page, 'note.md', 'dblclick');
  await waitShown(page, 1, 'note.md', 'setup');
  await explorer(page, 'one.pdf', 'dblclick');
  await waitShown(page, 1, 'one.pdf', 'setup');

  // CT: file → file, and typing lands in the landed editor.
  await tabOf(page, 1, 'b.ts').click();
  await waitShown(page, 1, 'b.ts', 'CT');
  await clickEditor(1);
  await page.keyboard.press('Control+Tab');
  await waitShown(page, 1, 'c.ts', 'CT');
  if (await expectFocus('CT file→file', 1, 'editor:c.ts')) {
    await page.keyboard.type('Q');
    const typed = await page
      .waitForFunction(
        () =>
          (window.monaco?.editor.getModels() ?? []).some(
            (m) => m.uri.path.endsWith('/c.ts') && m.getValue().includes('Q'),
          ),
        null,
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    log('CT: a typed character reached c.ts:', typed);
    if (!typed) misses.push('CT: the character typed after Ctrl+Tab did not reach c.ts');
    else await page.keyboard.press('Control+z');
  } else {
    await page.keyboard.type('Q');
    const where = await page.evaluate(() =>
      (window.monaco?.editor.getModels() ?? [])
        .filter((m) => m.getValue().includes('Q'))
        .map((m) => m.uri.path),
    );
    log('CT: models holding the typed character:', JSON.stringify(where));
    misses.push('CT: the character typed after Ctrl+Tab did not reach c.ts');
  }

  // CT: file → diff lands in the diff's modified editor.
  await tabOf(page, 1, 'c.ts').click();
  await clickEditor(1);
  await page.keyboard.press('Control+Tab');
  await page.waitForSelector(`${G(1)} .monaco-diff-editor`, { timeout: 15000 });
  await expectFocus('CT file→diff', 1, 'diff-modified');

  // TT: a pointer click on the Terminal button activates it but leaves focus out of xterm.
  await tabOf(page, 1, 'a.ts').click();
  await clickEditor(1);
  await page.locator(`${G(1)} [data-tabid="__terminal__"]`).click();
  await page.waitForFunction(
    (sel) => !document.querySelector(`${sel} [role="tab"][aria-selected="true"]`),
    G(1),
    { timeout: 5000 },
  );
  await sleep(500);
  const afterClick = await focusNow(page);
  log(`TT Terminal click: focus is in group ${afterClick.group} ${afterClick.view}`);
  if (afterClick.view === 'terminal') misses.push('TT: a Terminal click moved focus into xterm');

  // CT: Ctrl+PageUp from the first doc lands in the Terminal.
  await tabOf(page, 1, 'a.ts').click();
  await clickEditor(1);
  await page.keyboard.press('Control+PageUp');
  await expectFocus('CT file→Terminal', 1, 'terminal');

  // TC: a tab click.
  await tabOf(page, 1, 'a.ts').click();
  await waitShown(page, 1, 'a.ts', 'TC');
  await expectFocus('TC tab click', 1, 'editor:a.ts');

  // CW: the Ctrl+W successor (b.ts's left neighbour, a.ts).
  await tabOf(page, 1, 'b.ts').click();
  await waitShown(page, 1, 'b.ts', 'CW');
  await clickEditor(1);
  await page.keyboard.press('Control+w');
  await waitShown(page, 1, 'a.ts', 'CW');
  await expectFocus('CW Ctrl+W successor', 1, 'editor:a.ts');

  // PT: the palette names the command "Split Editor Right" (spec §9).
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill('>split editor');
  await page.locator('.palette__title', { hasText: /split/i }).first().waitFor({ timeout: 5000 });
  const titles = await page.locator('.palette__title').allTextContents();
  assert(titles.includes('Split Editor Right'), `PT: palette titles ${JSON.stringify(titles)}`);
  await page.keyboard.press('Escape');

  // SR: Split Right on rendered markdown.
  await tabOf(page, 1, 'note.md').click();
  await waitShown(page, 1, 'note.md', 'SR');
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'note.md', 'SR');
  await expectFocus('SR markdown', 2, 'markdown');

  // SR: Split Right on a PDF.
  await tabOf(page, 1, 'one.pdf').click();
  await waitShown(page, 1, 'one.pdf', 'SR');
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'one.pdf', 'SR');
  await expectFocus('SR pdf', 2, 'pdf');

  // MV: moving c.ts leaves a.ts (its left neighbour) to mount in the left group.
  await tabOf(page, 1, 'c.ts').click();
  await waitShown(page, 1, 'c.ts', 'MV');
  await tabOf(page, 1, 'c.ts').click({ button: 'right' });
  const move = page.locator('.ctxmenu__item', { hasText: /^Move to Other Group$/ });
  await move.waitFor({ timeout: 5000 }).catch(() => assert(false, 'MV: no Move to Other Group'));
  await move.click();
  await waitShown(page, 2, 'c.ts', 'MV');
  await expectFocus('MV move with a .ts fallback', 2, 'editor:c.ts');

  // SB: each strip's split button says what clicking IT would do.
  await tabOf(page, 1, 'a.ts').click();
  await waitShown(page, 1, 'a.ts', 'SB');
  assert(
    same(await splitButtons(), [null, 'true']),
    `SB left active: ${JSON.stringify(await splitButtons())}`,
  );
  await tabOf(page, 2, 'c.ts').click();
  await waitShown(page, 2, 'c.ts', 'SB');
  assert(
    same(await splitButtons(), [null, 'true']),
    `SB right active: ${JSON.stringify(await splitButtons())}`,
  );
  await page.locator(`${G(1)} .tabbar__split`).click();
  await waitShown(page, 2, 'a.ts', 'SB');
  await expectFocus('SB left strip button with the right group active', 2, 'editor:a.ts');

  // E6: the right group closes while the left one shows the Terminal.
  await page.locator(`${G(1)} [data-tabid="__terminal__"]`).click();
  await page.waitForFunction(
    (sel) => !document.querySelector(`${sel} [role="tab"][aria-selected="true"]`),
    G(1),
    { timeout: 5000 },
  );
  assert(
    same(await splitButtons(), ['true', 'true']),
    `SB left on the Terminal: ${JSON.stringify(await splitButtons())}`,
  );
  await tabOf(page, 2, 'c.ts').click();
  await waitShown(page, 2, 'c.ts', 'E6');
  const strip = await page.locator(`${G(2)} .tabbar`).boundingBox();
  await page.mouse.click(strip.x + strip.width - 6, strip.y + strip.height / 2, {
    button: 'right',
  });
  const close = page.locator('.ctxmenu__item', { hasText: /^Close Editor Group$/ });
  await close.waitFor({ timeout: 5000 }).catch(() => assert(false, 'E6: no Close Editor Group'));
  await close.click();
  const discard = page.locator('.confirm__actions button', { hasText: 'Discard' }).first();
  if (
    await discard.waitFor({ timeout: 1000 }).then(
      () => true,
      () => false,
    )
  ) {
    await discard.click();
  }
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 1, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'E6: the right group did not close'));
  await expectFocus('E6 collapse onto the Terminal', 1, 'terminal');

  // XT: closing the last doc tab with its × lands on the Terminal but leaves focus out of xterm.
  const docTabs = page.locator(`${G(1)} [role="tab"]`);
  await docTabs.first().click();
  for (let n = await docTabs.count(); n > 0; n = await docTabs.count()) {
    await docTabs.first().locator('.tab__close').click();
    const discardClose = page.locator('.confirm__actions button', { hasText: 'Discard' }).first();
    if (
      await discardClose.waitFor({ timeout: 500 }).then(
        () => true,
        () => false,
      )
    ) {
      await discardClose.click();
    }
    await page
      .waitForFunction(
        ({ sel, was }) => document.querySelectorAll(`${sel} [role="tab"]`).length < was,
        { sel: G(1), was: n },
        { timeout: 5000 },
      )
      .catch(() => assert(false, `XT: a × close left ${n} tabs`));
  }
  await sleep(500);
  const afterClose = await focusNow(page);
  log(`XT last × close: focus is in group ${afterClose.group} ${afterClose.view}`);
  if (afterClose.view === 'terminal') {
    misses.push('XT: a × close landing on the Terminal moved focus into xterm');
  }

  assert(misses.length === 0, `focus missed ${misses.length} step(s):\n  ${misses.join('\n  ')}`);
});

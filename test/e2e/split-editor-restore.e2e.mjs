/**
 * split-editor-restore — restoring both groups, and closing a group
 * (docs/specs/2026-09-28-split-editor.md §7). Starts from split-editor-tabs' end state, replayed as
 * setup in one launch (`replaySplitToE6` + `replayMoves` + `replayTabs`):
 *   E9  a restart (launch 2) restores each group's tabs, order and shown tab.
 *   CG  Close Editor Group from the right strip prompts for a dirty tab: Cancel keeps the group,
 *       Discard closes it.
 *   TP  the Workspace Trust prompt stays visible and clickable above a web tab active in the left
 *       group (web hosts sit in the grid's body row, the prompt in its own row). Needs go + gopls.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  finishScenario,
  launchApp,
  makeLog,
  openSession,
  profileDir,
  shutdownApp,
  tapBridge,
} from './harness.mjs';
import {
  focusEditor,
  G,
  groupCount,
  groupState,
  groupTabs,
  makeSplitRepo,
  openFromExplorer,
  press,
  replayMoves,
  replaySplitToE6,
  same,
  setupExplorer,
  sleep,
  tabOf,
  until,
  untilDirty,
  untilShown,
  waitPolite,
} from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor-restore] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('split-editor-restore');

const { repoArg, repoName, hasGit } = makeSplitRepo();
const userDataDir = profileDir('split');

const hasBinary = (name) => spawnSync('where', [name], { stdio: 'ignore' }).status === 0;
const goplsInstalled = () =>
  hasBinary('gopls') || existsSync(join(homedir(), 'go', 'bin', 'gopls.exe'));

/** split-editor-tabs' E7, E15, E16, P8 and E11 steps, as setup. */
async function replayTabs(page) {
  await press(tabOf(page, 1, 'c.ts'));
  await setupExplorer(page, 'b.ts', 'dblclick');
  await untilShown(page, 1, 'b.ts');
  await press(tabOf(page, 2, 'b.ts'));
  await untilShown(page, 2, 'b.ts');
  await focusEditor(page, G(2));
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' // e7');
  await untilDirty(page, 2);
  await press(tabOf(page, 1, 'b.ts'), { button: 'middle' });
  await until(
    page,
    (sel) =>
      ![...document.querySelectorAll(`${sel} [role="tab"] span`)].some(
        (e) => e.textContent === 'b.ts',
      ),
    G(1),
  );

  await focusEditor(page, G(2));
  await page.keyboard.press('Control+S');
  await untilDirty(page, 0);
  // E15's own waits were slow enough for the change markers to land before Alt+F5; setup's are not.
  await until(
    page,
    (sel) =>
      window.monaco.editor
        .getEditors()
        .find((e) => e.getContainerDomNode().closest(sel))
        ?.getModel()
        ?.getAllDecorations()
        .some(
          (d) =>
            d.options.linesDecorationsClassName?.includes('cdec') && d.range.startLineNumber >= 200,
        ) ?? false,
    G(2),
  );
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Alt+F5');
  await until(
    page,
    (sel) => {
      const ed = window.monaco.editor
        .getEditors()
        .find((e) => e.getContainerDomNode().closest(sel));
      return (ed?.getPosition()?.lineNumber ?? 0) >= 200;
    },
    G(2),
  );

  await press(tabOf(page, 1, 'a.ts'));
  await untilShown(page, 1, 'a.ts');
  await setupExplorer(page, 'z.ts', 'click');
  await untilShown(page, 1, 'z.ts');
  await setupExplorer(page, 'x.ts', 'click');
  await untilShown(page, 1, 'x.ts');
  await setupExplorer(page, 'y.ts', 'click');
  await untilShown(page, 1, 'y.ts');

  await focusEditor(page, G(2));
  await setupExplorer(page, 'p.ts', 'click');
  await untilShown(page, 2, 'p.ts');
  await focusEditor(page, G(2));
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// p8');
  await untilDirty(page, 1);
  await setupExplorer(page, 'q.ts', 'click');
  await untilShown(page, 2, 'q.ts');
  await press(tabOf(page, 2, 'p.ts'));
  await focusEditor(page, G(2));
  await page.keyboard.press('Control+S');
  await untilDirty(page, 0);

  const tabs = await groupTabs(page, 2);
  await page.keyboard.press('Control+2');
  await untilShown(page, 2, tabs[1]);
  await page.keyboard.press('Control+Tab');
  await untilShown(page, 2, tabs[2]);
  await page.keyboard.press('Control+W');
  await until(
    page,
    ({ sel, n }) =>
      ![...document.querySelectorAll(`${sel} [role="tab"] span`)].some((e) => e.textContent === n),
    { sel: G(2), n: tabs[2] },
  );
}

/** Close Editor Group from the right strip's background: a dirty tab prompts; Cancel keeps it. */
async function phaseCloseGroup(page) {
  await tabOf(page, 2, 'q.ts').click();
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// q');
  await page.waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 1, null, {
    timeout: 5000,
  });
  const openMenu = async () => {
    const strip = await page.locator(`${G(2)} .tabbar`).boundingBox();
    await page.mouse.click(strip.x + strip.width - 6, strip.y + strip.height / 2, {
      button: 'right',
    });
    const item = page.locator('.ctxmenu__item', { hasText: /^Close Editor Group$/ });
    await item
      .waitFor({ timeout: 5000 })
      .catch(() => assert(false, 'CG: the right strip has no Close Editor Group item'));
    await item.click();
    await page
      .waitForSelector('.confirm[role="alertdialog"]', { timeout: 8000 })
      .catch(() => assert(false, 'CG: no unsaved-changes prompt for the dirty q.ts'));
  };
  await openMenu();
  await page.locator('.confirm__actions button', { hasText: 'Cancel' }).first().click();
  await sleep(500);
  assert((await groupCount(page)) === 2, 'CG: Cancel still closed the right group');
  assert((await groupTabs(page, 2)).includes('q.ts'), 'CG: Cancel lost q.ts');
  await openMenu();
  await page.locator('.confirm__actions button', { hasText: 'Discard' }).first().click();
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 1, null, {
      timeout: 8000,
    })
    .catch(() => assert(false, 'CG: Discard did not close the right group'));
  await waitPolite(page, 'Editor group closed', 'CG');
  log('CG ✓ Close Editor Group prompts for a dirty tab; Cancel keeps it, Discard closes');
}

async function phaseTrustOverWeb(page) {
  if (!hasBinary('go') || !goplsInstalled()) {
    // Not the word the runner reads as a whole-scenario skip.
    log('TP not run (no go toolchain)');
    return;
  }
  await openFromExplorer(page, 'main.go');
  const prompt = page.locator('.trust-prompt');
  await prompt
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => assert(false, 'TP: the trust prompt did not appear for main.go'));

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>split web</title><body>web</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.click('.omnibar');
    await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
    await page.fill('.palette__input', '>open web page');
    await page.waitForSelector('.palette__title', { timeout: 8000 });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal__input', { state: 'visible', timeout: 8000 });
    await page.fill('.modal__input', `http://127.0.0.1:${server.address().port}/`);
    await page.keyboard.press('Enter');
    const hostSel = '.editorgroups > .webhost[data-group="1"]:not([hidden])';
    await page
      .locator(hostSel)
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => assert(false, 'TP: no visible web host in the left group'));
    await prompt
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => assert(false, 'TP: the trust prompt left when the web tab opened'));
    const probe = await page.evaluate((sel) => {
      const p = document.querySelector('.trust-prompt');
      const h = document.querySelector(sel);
      const btn = p?.querySelector('.btn--primary');
      if (!p || !h || !btn) return null;
      const pr = p.getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
      return {
        promptBottom: pr.bottom,
        hostTop: hr.top,
        hostHeight: hr.height,
        hitsPrompt: !!hit?.closest('.trust-prompt'),
      };
    }, hostSel);
    assert(probe, 'TP: prompt, web host or Trust button missing');
    log('TP: rects', JSON.stringify(probe));
    assert(probe.hostHeight > 0, 'TP: the web host has no height');
    assert(
      probe.hostTop >= probe.promptBottom - 0.5,
      `TP: the web host (top ${probe.hostTop}) overlaps the trust prompt (bottom ${probe.promptBottom})`,
    );
    assert(probe.hitsPrompt, 'TP: the Trust button is covered by the web host');
    log('TP ✓ the trust prompt stays above a left-group web tab');
  } finally {
    server.close();
  }
}

let launched = null;
let code = 0;
try {
  launched = await launchApp({ userDataDir });
  let { page } = launched;
  const sid = await openSession(page, { path: repoArg });
  await replaySplitToE6(page);
  await replayMoves(page, hasGit);
  await replayTabs(page);

  // E9
  await page.locator(`${G(2)} .tab--active`).click();
  await page
    .waitForSelector(`${G(2)}[data-active="true"]`, { timeout: 5000 })
    .catch(() => assert(false, 'E9: clicking the right group’s tab did not activate it'));
  const saved = [await groupState(page, 1), await groupState(page, 2)];
  await sleep(1500);
  await shutdownApp(launched.app, page);
  launched = null;
  launched = await launchApp({ userDataDir });
  page = launched.page;
  await tapBridge(page);
  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 45000,
  });
  await page.waitForSelector(`.session:has-text("${repoName}")`, { timeout: 20000 });
  await page.locator('.session', { hasText: repoName }).first().click();
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
      timeout: 20000,
    })
    .catch(() => assert(false, 'E9: the split did not restore'));
  await sleep(500);
  const restored = [await groupState(page, 1), await groupState(page, 2)];
  assert(
    same(restored, saved),
    `E9: restored ${JSON.stringify(restored)}, saved ${JSON.stringify(saved)}`,
  );
  assert(
    (await page.locator(G(2)).getAttribute('data-active')) === 'true' &&
      (await page.locator(G(1)).getAttribute('data-active')) === null,
    'E9: the right group was active before quit but not after relaunch',
  );
  log('E9 ✓ tabs, order, shown tab per group and the active group survive a restart');

  await phaseCloseGroup(page);

  await phaseTrustOverWeb(page);

  log('PASS ✓ split-editor-restore: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor-restore] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor-restore] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
await finishScenario(code);

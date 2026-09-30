/**
 * split-editor-tabs — dirty and preview tabs across groups, and group-scoped tab keys
 * (docs/specs/2026-09-28-split-editor.md §7). Starts from split-editor-move's end state, replayed
 * as setup in one launch (`replaySplitToE6` + `replayMoves`). These steps run in that session, not
 * after a restart as in the unsplit original, so they no longer exercise a restored layout:
 *   E7  closing one of two dirty tabs of a file doesn't prompt; the survivor stays dirty.
 *   E15 the survivor then saves (Ctrl+S) and navigates changes (Alt+F5).
 *   E16 single clicks with the left group active reuse its preview, never the right's pinned tab.
 *   P8  typing in a preview pins that tab, so the next single click opens beside it.
 *   E11 Ctrl+2, Ctrl+Tab and Ctrl+W act on the active group's strip only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, finishScenario, launchApp, makeLog, openSession } from './harness.mjs';
import {
  editorPosition,
  explorer,
  G,
  groupState,
  groupTabs,
  makeSplitRepo,
  replayMoves,
  replaySplitToE6,
  same,
  sleep,
  tabOf,
  waitShown,
} from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor-tabs] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('split-editor-tabs');

const { repo, repoArg, hasGit } = makeSplitRepo();

const confirmOpen = (page) => page.locator('.confirm[role="alertdialog"]').count();

/** E7 + E15: one of two dirty b.ts tabs closes without a prompt; the survivor saves and navigates. */
async function phaseE7E15(page) {
  await tabOf(page, 1, 'c.ts').click();
  await explorer(page, 'b.ts', 'dblclick');
  await waitShown(page, 1, 'b.ts', 'E7');
  await tabOf(page, 2, 'b.ts').click();
  await waitShown(page, 2, 'b.ts', 'E7');
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' // e7');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 2, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'E7: both b.ts tabs should be dirty'));
  await tabOf(page, 1, 'b.ts').click({ button: 'middle' });
  await sleep(600);
  assert((await confirmOpen(page)) === 0, 'E7: closing one of two b.ts tabs prompted');
  assert(!(await groupTabs(page, 1)).includes('b.ts'), 'E7: the left b.ts tab did not close');
  assert(
    (await tabOf(page, 2, 'b.ts').getAttribute('class'))?.includes('tab--dirty'),
    'E7: the surviving b.ts tab is not dirty',
  );
  log('E7 ✓ one of two dirty tabs closes silently, the survivor stays dirty');

  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+S');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 0, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'E15: Ctrl+S in the survivor did not clear the dirty dot'));
  assert(
    readFileSync(join(repo, 'b.ts'), 'utf8').includes('// e7'),
    'E15: b.ts on disk lacks the edit',
  );
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Alt+F5');
  await page
    .waitForFunction(
      (sel) => {
        const ed = window.monaco.editor
          .getEditors()
          .find((e) => e.getContainerDomNode().closest(sel));
        return (ed?.getPosition()?.lineNumber ?? 0) >= 200;
      },
      G(2),
      { timeout: 8000 },
    )
    .catch(async () =>
      assert(
        false,
        `E15: Alt+F5 left the cursor at ${JSON.stringify(await editorPosition(page, 2))}`,
      ),
    );
  log('E15 ✓ the survivor saves and navigates changes');
}

/** E16: a single click with the left group active never takes a right-group pinned tab. */
async function phaseE16(page) {
  await tabOf(page, 1, 'a.ts').click();
  await waitShown(page, 1, 'a.ts', 'E16');
  await explorer(page, 'z.ts', 'click');
  await waitShown(page, 1, 'z.ts', 'E16 (preview)');
  await explorer(page, 'x.ts', 'click');
  await explorer(page, 'y.ts', 'click');
  await waitShown(page, 1, 'y.ts', 'E16');
  const left = await groupTabs(page, 1);
  assert(
    !left.includes('z.ts') && !left.includes('x.ts'),
    `E16: the left preview was not reused (${left})`,
  );
  assert(
    (await tabOf(page, 1, 'y.ts').getAttribute('class'))?.includes('tab--preview'),
    'E16: y.ts is not the left group’s preview',
  );
  assert((await groupTabs(page, 2)).includes('x.ts'), 'E16: the right group lost x.ts');
  log('E16 ✓ the right group keeps x.ts, the left preview is y.ts');
}

/** P8: an edited preview is pinned, so the next single click opens beside it. */
async function phaseP8(page) {
  await page.locator(`${G(2)} .monaco-editor`).click();
  await explorer(page, 'p.ts', 'click');
  await waitShown(page, 2, 'p.ts', 'P8');
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// p8');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 1, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'P8: p.ts did not turn dirty'));
  await explorer(page, 'q.ts', 'click');
  await waitShown(page, 2, 'q.ts', 'P8');
  const pCls = (await tabOf(page, 2, 'p.ts').getAttribute('class')) ?? '';
  assert(pCls.includes('tab--dirty') && !pCls.includes('tab--preview'), `P8: p.ts is "${pCls}"`);
  assert(
    (await tabOf(page, 2, 'q.ts').getAttribute('class'))?.includes('tab--preview'),
    'P8: q.ts did not open as a preview',
  );
  await tabOf(page, 2, 'p.ts').click();
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 0, null, {
    timeout: 5000,
  });
  log('P8 ✓ editing a preview pins that tab only');
}

/** E11: Ctrl+2, Ctrl+Tab and Ctrl+W act on the active group's strip only. */
async function phaseE11(page) {
  const left = await groupState(page, 1);
  const tabs = await groupTabs(page, 2);
  assert(tabs.length >= 3, `E11: the right group needs three tabs (${tabs})`);
  await page.keyboard.press('Control+2');
  await waitShown(page, 2, tabs[1], 'E11 Ctrl+2');
  await page.keyboard.press('Control+Tab');
  await waitShown(page, 2, tabs[2], 'E11 Ctrl+Tab');
  await page.keyboard.press('Control+W');
  await page
    .waitForFunction(
      ({ sel, n }) =>
        ![...document.querySelectorAll(`${sel} [role="tab"] span`)].some(
          (e) => e.textContent === n,
        ),
      { sel: G(2), n: tabs[2] },
      { timeout: 5000 },
    )
    .catch(() => assert(false, `E11: Ctrl+W did not close ${tabs[2]} in the right group`));
  const leftAfter = await groupState(page, 1);
  assert(
    same(leftAfter, left),
    `E11: the left group changed ${JSON.stringify(left)} → ${JSON.stringify(leftAfter)}`,
  );
  log('E11 ✓ tab keys act on the active group only');
}

let launched = null;
let code = 0;
try {
  launched = await launchApp();
  const { page } = launched;
  await openSession(page, { path: repoArg });
  await replaySplitToE6(page);
  await replayMoves(page, hasGit);

  await phaseE7E15(page);
  await phaseE16(page);
  await phaseP8(page);
  await phaseE11(page);

  log('PASS ✓ split-editor-tabs: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor-tabs] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor-tabs] ERROR:', e?.message || e);
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

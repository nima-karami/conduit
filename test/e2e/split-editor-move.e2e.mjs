/**
 * split-editor-move — moving tabs between editor groups and group-scoped navigation
 * (docs/specs/2026-09-28-split-editor.md §7). Starts from split-editor-split's end state, replayed
 * as setup in one launch (`replaySplitToE6`). These steps run in that session, not after a restart
 * as in the unsplit original, so they no longer exercise a restored layout:
 *   M1  with one group, Move to Other Group is enabled and Mod+Alt+ArrowRight creates the right
 *       group holding the tab, active and focused; the reverse move collapses it again.
 *   MV  Mod+Alt+ArrowRight moves the active tab from the left group to the right, which becomes
 *       active.
 *   RV  Review scrolled in one group, moved to the other, keeps its scroll anchor (±2px).
 *   E4  F12 in the left group navigates the left group; the right one is untouched.
 *   E5  explorer opens land in the active group, and in the right one while the left shows the
 *       Terminal.
 */

import { assert, finishScenario, launchApp, makeLog, openReview, openSession } from './harness.mjs';
import {
  editorPosition,
  explorer,
  G,
  groupCount,
  groupState,
  groupTabs,
  makeSplitRepo,
  openFromExplorer,
  replaySplitToE6,
  same,
  sleep,
  tabOf,
  tokenPoint,
  waitPolite,
  waitShown,
} from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor-move] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('split-editor-move');

const { repoArg, hasGit } = makeSplitRepo();

/** One group holding b.ts → split a.ts, then move b.ts from the left group with the keyboard. */
async function phaseMove(page) {
  await openFromExplorer(page, 'a.ts');
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Backslash');
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
    timeout: 10000,
  });
  await page.locator(`${G(1)} [role="tab"]`, { hasText: 'b.ts' }).click();
  await page.waitForSelector(`${G(1)}[data-active="true"] .tab--active`, { timeout: 5000 });
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Alt+ArrowRight');
  await page
    .waitForFunction(
      (sel) =>
        document.querySelector(`${sel}[data-active="true"] .tab--active span`)?.textContent ===
        'b.ts',
      G(2),
      { timeout: 5000 },
    )
    .catch(() => assert(false, 'MV: b.ts is not the active tab of an active right group'));
  const left = await groupTabs(page, 1);
  assert(!left.includes('b.ts'), `MV: b.ts is still in the left group (${left})`);
  assert(
    (await page.locator(G(1)).getAttribute('data-active')) === null,
    'MV: the left group is still active',
  );
  await waitPolite(page, 'Moved b.ts to right group', 'MV');
  log('MV ✓ Mod+Alt+ArrowRight moved b.ts to the right group');
}

/** One group holding b.ts: Move to Other Group creates group 2 (VS Code "Move Editor into Right
 *  Group"), then the reverse move collapses back to one group. */
async function phaseMoveOneGroup(page) {
  assert((await groupCount(page)) === 1, 'M1: expected one group');
  await tabOf(page, 1, 'b.ts').click({ button: 'right' });
  const item = page.locator('.ctxmenu__item', { hasText: /^Move to Other Group$/ });
  await item.waitFor({ timeout: 5000 }).catch(() => assert(false, 'M1: no Move to Other Group'));
  assert(!(await item.isDisabled()), 'M1: Move to Other Group is disabled with one group');
  await page.keyboard.press('Escape');
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Alt+ArrowRight');
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'M1: Mod+Alt+ArrowRight with one group did not create group 2'));
  await waitShown(page, 2, 'b.ts', 'M1');
  assert(!(await groupTabs(page, 1)).includes('b.ts'), 'M1: b.ts is still in the left group');
  await page
    .waitForFunction((sel) => !!document.activeElement?.closest(sel), G(2), { timeout: 5000 })
    .catch(() => assert(false, 'M1: focus is not in the right group'));
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 1, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'M1: moving b.ts back did not collapse to one group'));
  await waitShown(page, 1, 'b.ts', 'M1');
  log('M1 ✓ Move to Other Group with one group creates the right group');
}

/** The scroller's offset and the card at its top edge, with the edge's offset into that card. */
const reviewAnchor = (page, g) =>
  page.evaluate((sel) => {
    const el = document.querySelector(`${sel} .review__scroll`);
    if (!el) return null;
    const y = el.getBoundingClientRect().top;
    const card = [...el.querySelectorAll('.rcard')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .find((c) => c.getBoundingClientRect().bottom > y);
    return {
      scrollTop: Math.round(el.scrollTop),
      path: card?.getAttribute('data-path') ?? null,
      offset: card ? Math.round(y - card.getBoundingClientRect().top) : null,
    };
  }, G(g));

async function pressMove(page, g, key) {
  await page.focus(`${G(g)} .review__scroll`);
  await page.keyboard.press(key);
  const to = g === 1 ? 2 : 1;
  await page
    .waitForSelector(`${G(to)}[data-active="true"] .review__scroll`, { timeout: 10000 })
    .catch(() => assert(false, `RV: Review did not move to an active group ${to}`));
  await sleep(900);
  return reviewAnchor(page, to);
}

/**
 * Review opened in the left group, scrolled, moved right and back. The groups differ in width
 * (E8 left the ratio at ~0.3), so across them the top card and its offset are what must hold;
 * back in the same group the pixel offset must too (±2px).
 */
async function phaseReviewMove(page) {
  if (!hasGit) {
    log('RV not run (no git)');
    return;
  }
  await page.locator(`${G(1)} .monaco-editor`).click();
  await openReview(page);
  await page.waitForSelector(`${G(1)} .review .rcard[data-path="rv/f1.txt"] .rline`, {
    state: 'attached',
    timeout: 25000,
  });
  // Mid-list: a fraction of the estimate-sized scrollHeight lands on the end clamp once the
  // narrow group's real heights resolve, and an end-clamped offset can't survive a wider group.
  await page.$eval(`${G(1)} .review__scroll`, (el) => {
    el.scrollTop = 1500;
  });
  // Past the 120ms anchor-capture debounce and the re-measure it triggers.
  await sleep(900);
  const before = await reviewAnchor(page, 1);
  assert(
    before?.path && before.scrollTop > 200,
    `RV: expected a scrolled Review, got ${JSON.stringify(before)}`,
  );
  const right = await pressMove(page, 1, 'Control+Alt+ArrowRight');
  log('RV: anchor', JSON.stringify(before), '→', JSON.stringify(right));
  assert(
    right?.path === before.path && Math.abs(right.offset - before.offset) <= 2,
    `RV: the right group's top card is ${JSON.stringify(right)}, was ${JSON.stringify(before)}`,
  );
  const back = await pressMove(page, 2, 'Control+Alt+ArrowLeft');
  log('RV: back in the left group', JSON.stringify(back));
  assert(
    back && Math.abs(back.scrollTop - before.scrollTop) <= 2,
    `RV: Review's scroll moved from ${before.scrollTop} to ${back?.scrollTop}`,
  );
  log('RV ✓ Review moved with its scroll anchor');
}

/** E4: F12 in the left group's c.ts navigates the left group; the right group is untouched. */
async function phaseE4(page) {
  await page.focus(`${G(1)} .review__scroll`);
  await page.keyboard.press('Control+W');
  await page.waitForFunction(() => !document.querySelector('.review'), null, { timeout: 8000 });
  await explorer(page, 'c.ts', 'dblclick');
  await waitShown(page, 1, 'c.ts', 'E4');
  await page.waitForSelector(`${G(1)} .monaco-editor .view-lines`, { timeout: 15000 });
  const right = await groupState(page, 2);
  const at = await tokenPoint(page, 1, 'answer');
  assert(at, 'E4: `answer` is not painted in the left editor');
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press('F12');
  await waitShown(page, 1, 'a.ts', 'E4');
  const pos = await editorPosition(page, 1);
  assert(pos?.lineNumber === 1, `E4: the left editor is at ${JSON.stringify(pos)}, not line 1`);
  const after = await groupState(page, 2);
  assert(
    same(after, right),
    `E4: the right group changed ${JSON.stringify(right)} → ${JSON.stringify(after)}`,
  );
  log('E4 ✓ F12 stays in its group');
}

/** E5: an explorer open lands in the active group, and in group 2 while group 1 shows the Terminal. */
async function phaseE5(page) {
  await page.locator(`${G(2)} .monaco-editor`).click();
  await explorer(page, 'x.ts', 'dblclick');
  await waitShown(page, 2, 'x.ts', 'E5');
  assert(!(await groupTabs(page, 1)).includes('x.ts'), 'E5: x.ts also opened in the left group');
  await page.locator(`${G(1)} button.tab[data-tabid="__terminal__"]`).click();
  await page.waitForSelector(
    `${G(1)}[data-active="true"] button.tab--active[data-tabid="__terminal__"]`,
    {
      timeout: 5000,
    },
  );
  await explorer(page, 'y.ts', 'dblclick');
  await waitShown(page, 2, 'y.ts', 'E5 (Terminal in the left group)');
  assert(!(await groupTabs(page, 1)).includes('y.ts'), 'E5: y.ts opened in the left group');
  log('E5 ✓ opens follow the active group, and skip a Terminal-showing left group');
}

let launched = null;
let code = 0;
try {
  launched = await launchApp();
  const { page } = launched;
  await openSession(page, { path: repoArg });
  await replaySplitToE6(page);

  await phaseMoveOneGroup(page);

  await phaseMove(page);
  await phaseReviewMove(page);
  if (hasGit) {
    await phaseE4(page);
  } else {
    log('E4 not run (no git: it closes the Review tab RV opens)');
  }
  await phaseE5(page);

  log('PASS ✓ split-editor-move: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor-move] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor-move] ERROR:', e?.message || e);
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

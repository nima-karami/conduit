/**
 * New session dialog, the batch-file guard (mf-new-session spec §7 AC8): a .cmd shim with a
 * folder whose name holds `&` disables Start and posts nothing. Also the retired
 * new-session-browse-pinned.e2e.mjs's second half: the Add row does not move when the folder list
 * scrolls.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { assert, phase } from './harness.mjs';
import {
  browseAdd,
  clearFolders,
  closeDialog,
  hostMsgs,
  launchTapped,
  openDialog,
  pick,
  runNewSession,
} from './new-session-folders-helpers.mjs';

await runNewSession('new-session-folders-guard', async ({ fx, log, launch }) => {
  const { A, C, recents } = fx;
  const { app, page } = await launchTapped(launch);

  phase('batch-file guard');
  await openDialog(page);
  await clearFolders(page);
  await browseAdd(app, page, [A, C]);
  await pick(page, 'claude');
  await page.waitForFunction(
    () => document.querySelector('.ns__reason')?.textContent?.includes('x&y'),
    null,
    { timeout: 10000 },
  );
  const reason = await page.locator('.ns__reason').innerText();
  assert(
    reason ===
      'claude is a .cmd shim and can\'t take "x&y" (contains &). Rename the folder or use an .exe install.',
    `the guard names the folder and the character (got ${JSON.stringify(reason)})`,
  );
  assert(await page.locator('.ns__foot .btn--primary').isDisabled(), 'Start is disabled');
  const sessionsBefore = await page.evaluate(() => window.__sessions.length);
  const opensBefore = (await hostMsgs(app)).filter((t) => t === 'openRepo').length;
  await page.locator('.ns__foot .btn--primary').click({ force: true });
  await page.focus('.modal.ns');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const opensAfter = (await hostMsgs(app)).filter((t) => t === 'openRepo').length;
  assert(opensAfter === opensBefore, `no openRepo is posted (${opensBefore} → ${opensAfter})`);
  assert(
    (await page.evaluate(() => window.__sessions.length)) === sessionsBefore,
    'and no session appears',
  );
  assert(await page.isVisible('.modal.ns'), 'the dialog stays open');
  log('batch-file guard: Start disabled, nothing posted ✓ (AC8)');

  const extra = recents.slice(0, 8).map((r) => r.path);
  await browseAdd(app, page, extra);
  const pinned = await page.evaluate(() => {
    const list = document.querySelector('.ns-folders');
    const add = document.querySelector('.ns-folders__add');
    const before = add?.getBoundingClientRect().top;
    if (list) list.scrollTop = list.scrollHeight;
    return {
      overflow: (list?.scrollHeight ?? 0) - (list?.clientHeight ?? 0),
      scrolled: list?.scrollTop ?? 0,
      moved: (add?.getBoundingClientRect().top ?? 0) - (before ?? 0),
      inList: !!list?.contains(add),
    };
  });
  assert(
    pinned.overflow > 0 && pinned.scrolled > 0,
    `ten folders overflow and scroll the list (${JSON.stringify(pinned)})`,
  );
  assert(
    !pinned.inList && pinned.moved === 0,
    `+ Add folder… stays pinned under the list (${JSON.stringify(pinned)})`,
  );
  log('folders list scrolls inside its bound; Add stays pinned ✓');
  await closeDialog(page);
});

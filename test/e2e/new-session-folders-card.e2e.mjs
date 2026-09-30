/**
 * New session dialog, starting guards and prefill (mf-new-session spec §7, §4): Enter held while
 * the host answers at once starts one session, and the board card's "Start session for this card"
 * prefills the dialog and stamps the card id.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { assert, openSession, phase } from './harness.mjs';
import {
  browseAdd,
  CARD,
  clearFolders,
  folderNames,
  hostMsgs,
  launchTapped,
  openDialog,
  pick,
  runNewSession,
  waitPreview,
} from './new-session-folders-helpers.mjs';

await runNewSession('new-session-folders-card', async ({ fx, log, launch }) => {
  const { A, B } = fx;
  const { app, page } = await launchTapped(launch);

  phase('Enter held');
  // The reply lands before the dialog unmounts; a repeat in that gap started a second session
  // (Re-QA F1). The earlier double-start check held the reply, so it could not see this.
  await openDialog(page);
  await clearFolders(page);
  await browseAdd(app, page, [A]);
  await pick(page, 'claude');
  await waitPreview(page, `${A}> claude`);
  const heldSessions = await page.evaluate(() => window.__sessions.length);
  const heldOpens = (await hostMsgs(app)).filter((t) => t === 'openRepo').length;
  await page.focus('.modal.ns');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter');
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
  await page.waitForTimeout(1500);
  const heldOpensAfter = (await hostMsgs(app)).filter((t) => t === 'openRepo').length;
  assert(
    heldOpensAfter - heldOpens === 1,
    `six Enters post exactly one openRepo (got ${heldOpensAfter - heldOpens})`,
  );
  const heldSessionsAfter = await page.evaluate(() => window.__sessions.length);
  assert(
    heldSessionsAfter - heldSessions === 1,
    `and create exactly one session (got ${heldSessionsAfter - heldSessions})`,
  );
  log('Enter held with an immediate reply: one openRepo, one session ✓ (spec §4)');

  phase('board card prefill');
  const boardHost = await openSession(page, { path: A, roots: [B] });
  log('board host session:', boardHost);
  await page.locator('.viewswitch__btn[title="Feature Board"]').click();
  const card = page.locator('.bcard', { hasText: CARD.title }).first();
  await card.waitFor({ state: 'visible', timeout: 15000 });
  await card.click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: 'Start session for this card' }).click();
  await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 10000 });
  const sub = await page.locator('.modal.ns .modal__sub').innerText();
  assert(sub === `Start a session for "${CARD.title}"`, `the subtitle names the card (got ${sub})`);
  assert(
    JSON.stringify(await folderNames(page)) ===
      JSON.stringify(['room-message-bus', 'bitbucket-ci-image']),
    `the card prefill carries the active session's folders (got ${await folderNames(page)})`,
  );
  const resultsBefore = await page.evaluate(() => window.__results.length);
  await page.waitForFunction(
    () => !document.querySelector('.ns__foot .btn--primary')?.disabled,
    null,
    { timeout: 10000 },
  );
  await page.locator('.ns__foot .btn--primary').click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
  const cardSid = await page
    .waitForFunction(
      (n) => window.__results.slice(n).find((m) => m.type === 'openRepo:result')?.sessionId ?? null,
      resultsBefore,
    )
    .then((h) => h.jsonValue());
  const cardSession = await page
    .waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, cardSid)
    .then((h) => h.jsonValue());
  assert(cardSession.cardId === CARD.id, `Start stamps the card id (got ${cardSession.cardId})`);
  log('board card prefill: subtitle, folders, cardId ✓ (AC7)');
});

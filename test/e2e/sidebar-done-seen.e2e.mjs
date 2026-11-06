/**
 * sidebar-done-seen — the server's completion counter and the renderer's strict "seen" rule
 * (spec docs/specs/archive/2026-11-02-sidebar-agent-tree.md §4; plan "E2e migration manifest"). Every fact
 * comes from the real server: qualifying bursts, OSC 7501 reports and bare bells in cmd shells.
 *   - a qualifying run in a background session counts (`completions` on the broadcast) and the row
 *     reads Done in the Done group; a second run coalesces into the same single Done row;
 *   - a reported Working→Done counts once; Blocked and a bell are Needs you, never completions;
 *   - an unfocused window, an editor doc or the Board in front of the terminal, and a background
 *     split all keep Done; only the focused, shown terminal of a looking window clears it, and a
 *     run that ends while viewed never shows Done at all (it still counts);
 *   - a renderer reload baselines every counter: no historical Done;
 *   - a server restart resets the counters and the renderer clamps seen, so the next run is Done.
 * (Ask → Needs you is in status-bar, which already holds an ask.)
 *
 * The window-level half of the strict rule uses App's e2e seam `window.__conduitWindowLooking`
 * (see setWindowLooking in attention-footer-helpers.mjs); terminal focus and the center view are
 * driven for real.
 */
import { join } from 'node:path';
import {
  assertRowStays,
  bell,
  burst,
  completionsOf,
  documentLooking,
  focusTerminal,
  groupOf,
  report,
  restartServer,
  resyncAfterRestart,
  rowMenu,
  rowState,
  SPAWN_GRACE_WAIT_MS,
  selectRow,
  sessionOf,
  setWindowLooking,
  sleep,
  waitCompletions,
  waitRowState,
} from './attention-footer-helpers.mjs';
import { closeAllDocs, openDoc } from './goto-matrix.mjs';
import {
  assert,
  openSession,
  phase,
  REPO,
  runCommand,
  runScenario,
  tapBridge,
} from './harness.mjs';

const rowsOf = (page, sid) =>
  page.locator(`[data-agent-tree] .session[data-sessionid="${sid}"]`).count();

await runScenario('sidebar-done-seen', async ({ app, page, userDataDir, log }) => {
  await tapBridge(page);
  log('document looking at launch:', JSON.stringify(await documentLooking(page)));

  phase('setup');
  const repo = REPO.replace(/\\/g, '/');
  // H: heuristic runs; S: the split; R: reports OSC 7501 (heuristics off for it from then on);
  // B: rings a bell; P: opened last, so it is the active one the others hide behind.
  const H = await openSession(page, { path: repo });
  const S = await openSession(page, { path: repo });
  const R = await openSession(page, { path: repo });
  const B = await openSession(page, { path: repo });
  const P = await openSession(page, { path: repo });
  log('sessions', JSON.stringify({ H, S, R, B, P }));
  await selectRow(page, P);
  await setWindowLooking(page, false);
  await sleep(SPAWN_GRACE_WAIT_MS);
  const h0 = await completionsOf(page, H);
  const r0 = await completionsOf(page, R);
  const b0 = await completionsOf(page, B);
  assert(
    [h0, r0, b0].every((n) => Number.isInteger(n) && n >= 0),
    `completions missing on the broadcast: ${JSON.stringify({ h0, r0, b0 })}`,
  );

  phase('unseen run counts; bell is Needs you');
  await bell(page, B);
  await report(page, R, 'working');
  await burst(page, H, 'u1');
  await waitCompletions(page, H, h0 + 1, 'a background qualifying run');
  await waitRowState(page, H, 'Done', 'an unseen completion');
  assert((await groupOf(page, H)) === 'done', `H is in group ${await groupOf(page, H)}`);
  await waitRowState(page, B, 'Needs you', 'a bell in a background session');
  assert((await groupOf(page, B)) === 'blocked', `B is in group ${await groupOf(page, B)}`);
  const bReason = (await sessionOf(page, B))?.attentionReason;
  assert(bReason === 'bell', `B attentionReason: ${bReason}`);
  log('background run → Done; bell → Needs you ✓');

  phase('repeated runs coalesce; reported Done counts once');
  assert(
    await page
      .waitForFunction((id) => window.__sessions.find((s) => s.id === id)?.busy === true, R, {
        timeout: 10_000,
      })
      .then(
        () => true,
        () => false,
      ),
    'R never read Working from its report',
  );
  await report(page, R, 'done');
  await burst(page, H, 'u2');
  await waitCompletions(page, R, r0 + 1, 'a reported Working→Done');
  await waitRowState(page, R, 'Done', 'a reported Done in the background');
  await waitCompletions(page, H, h0 + 2, 'a second background run');
  await waitRowState(page, H, 'Done', 'two unseen runs');
  assert((await rowsOf(page, H)) === 1, `H has ${await rowsOf(page, H)} rows`);
  // The bell rang well over a quiet window ago: had it counted, it would show by now.
  assert(
    (await completionsOf(page, B)) === b0,
    `a bell alone completed a run: ${await completionsOf(page, B)} (was ${b0})`,
  );
  log('two runs, one Done row; reported Done +1; bell not a completion ✓');

  phase('Blocked is Needs you, not a completion');
  await report(page, R, 'working');
  await waitRowState(page, R, 'Working', 'a reported Working');
  await report(page, R, 'blocked');
  await waitRowState(page, R, 'Needs you', 'a reported Blocked in the background');
  assert((await groupOf(page, R)) === 'blocked', `R is in group ${await groupOf(page, R)}`);
  const rFacts = await sessionOf(page, R);
  assert(rFacts?.attentionReason === 'blocked', `R attentionReason: ${rFacts?.attentionReason}`);
  await sleep(1_500);
  assert(
    (await completionsOf(page, R)) === r0 + 1,
    `entering Blocked counted a completion: ${await completionsOf(page, R)}`,
  );
  log('Blocked → Needs you, no completion ✓');

  phase('unfocused window keeps Done');
  await selectRow(page, H);
  await focusTerminal(page, 'active');
  await assertRowStays(page, H, 'Done', 'the focused terminal of an unfocused window');
  log('unfocused window keeps Done ✓');

  phase('strict viewing clears Done');
  await setWindowLooking(page, true);
  await waitRowState(page, H, 'Idle', 'the focused, shown terminal of a looking window');
  assert((await completionsOf(page, H)) === h0 + 2, 'viewing changed the server counter');
  log('strict viewing clears Done ✓');

  phase('a run while viewed counts but never shows Done');
  await burst(page, H, 'v1');
  {
    const deadline = Date.now() + 15_000;
    let counted = false;
    while (Date.now() < deadline && !counted) {
      const st = await rowState(page, H);
      assert(st !== 'Done', 'a run that ended while viewed showed Done');
      counted = (await completionsOf(page, H)) === h0 + 3;
      await sleep(100);
    }
    assert(counted, `the viewed run did not count: ${await completionsOf(page, H)}`);
  }
  await assertRowStays(page, H, 'Idle', 'after a viewed run');
  log('viewed run counts, no Done ✓');

  phase('an editor doc and the Board keep Done');
  await openDoc(app, page, H, join(REPO, 'package.json'));
  await burst(page, H, 'e1');
  await waitCompletions(page, H, h0 + 4, 'a run behind an editor doc');
  await waitRowState(page, H, 'Done', 'active behind an editor doc');
  await assertRowStays(page, H, 'Done', 'active behind an editor doc');
  await runCommand(page, 'Open feature board');
  await page.locator('.board').first().waitFor({ state: 'visible', timeout: 10_000 });
  await assertRowStays(page, H, 'Done', 'active behind the Board');
  await runCommand(page, 'Open editor');
  await closeAllDocs(page);
  await focusTerminal(page, 'active');
  await waitRowState(page, H, 'Idle', 'the terminal shown again and focused');
  log('editor doc / Board keep Done; shown terminal clears ✓');

  phase('a background split keeps Done');
  await rowMenu(page, S, 'Open in split pane');
  await page.locator('.termstack > .termhost > .termhost__bar').waitFor({ timeout: 10_000 });
  const s0 = await completionsOf(page, S);
  await focusTerminal(page, 'active');
  await burst(page, S, 's1');
  await waitCompletions(page, S, s0 + 1, 'a run in the split');
  await waitRowState(page, S, 'Done', 'a background split');
  await assertRowStays(page, S, 'Done', 'a background split');
  await focusTerminal(page, 'split');
  await waitRowState(page, S, 'Idle', 'the split once focused');
  log('background split keeps Done until focused ✓');

  phase('reload baselines every counter');
  await selectRow(page, P);
  await burst(page, H, 'r1');
  await waitCompletions(page, H, h0 + 5, 'a run before the reload');
  await waitRowState(page, H, 'Done', 'unseen before the reload');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20_000 });
  await tapBridge(page);
  await page
    .locator(`[data-agent-tree] .session[data-sessionid="${H}"]`)
    .waitFor({ timeout: 20_000 });
  await setWindowLooking(page, false);
  assert(
    (await completionsOf(page, H)) === h0 + 5,
    `the counter did not survive the reload: ${await completionsOf(page, H)}`,
  );
  await waitRowState(page, H, 'Idle', 'H after the reload');
  await assertRowStays(page, H, 'Idle', 'H after the reload');
  const doneAfterReload = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-agent-tree] .session'))
      .filter((r) => (r.getAttribute('aria-label') ?? '').includes(', Done'))
      .map((r) => r.getAttribute('data-sessionid')),
  );
  assert(doneAfterReload.length === 0, `historical Done after reload: ${doneAfterReload}`);
  // Reasons are live server facts, not history: they survive the reload.
  await waitRowState(page, R, 'Needs you', 'R after the reload');
  log('reload: no historical Done, reasons kept ✓');

  phase('server restart clamps seen');
  const reply = await restartServer(userDataDir);
  log(`server.restart reply: ${JSON.stringify(reply)}`);
  await resyncAfterRestart(page, H);
  await waitCompletions(page, H, 0, 'the restarted server', 30_000);
  // The new server's attach may restart the spawn grace; a run inside it is not evidence.
  await sleep(SPAWN_GRACE_WAIT_MS);
  await burst(page, H, 'x1');
  await waitCompletions(page, H, 1, 'the first run on the restarted server');
  await waitRowState(page, H, 'Done', 'a run after the counter went back to zero');
  log('restart: seen clamped, next run Done ✓');
});

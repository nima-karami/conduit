/**
 * The renderer must receive the host's startup `state` without being prodded.
 *
 * `ready` is a handshake, not a beacon: the host answers it with state / win:list / restoreDocs /
 * review:marks. Posted at module scope (as it was before this scenario existed) the burst could
 * land before React mounted, and `message-bus.ts` only buffers while NOBODY is subscribed — one
 * module-scope subscriber (`review-marks-store.ts`, added in acd3106) was enough to consume the
 * burst on its own and lose the initial `state`. The app then sat on the empty-state CTA with a
 * session the host had already created, until some later broadcast happened to arrive.
 *
 * The assertion has to be made on a VIRGIN page: `tapBridge` re-posts `ready`, which is exactly
 * the prod that hides the bug. So this scenario never posts anything to the host.
 *
 * The session itself comes from the harness launching `electron <REPO>`: main.ts's cold-launch
 * `openArg(process.argv)` opens that directory as a session before the window loads.
 */

import { assert, closeApp, runScenario } from './harness.mjs';

runScenario('session-bootstrap', async ({ app, page, log }) => {
  await page.waitForSelector('.tabbar-wrap', { state: 'attached', timeout: 20000 });

  const view = await page.evaluate(() => ({
    empty: !!document.querySelector('.center-empty'),
    tabbar: !!document.querySelector('.tabbar-wrap'),
    cards: document.querySelectorAll('.session').length,
  }));
  log(`centre: ${JSON.stringify(view)}`);
  assert(view.tabbar, 'the centre pane must show the tab strip for the cold-launch session');
  assert(!view.empty, 'the empty-state CTA must not be shown when the host owns a session');
  assert(view.cards >= 1, `the session rail must list the cold-launch session, got ${view.cards}`);

  await closeApp(app, page);
});

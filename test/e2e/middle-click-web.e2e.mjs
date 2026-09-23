/**
 * middle-click-web — a middle-click inside an in-app web tab's guest opens a background web tab
 * (docs/specs/2026-09-22-middle-click-new-tab.md S14, AC-17).
 *
 * Input is sent to the guest webContents from the main process (`sendInputEvent`), so the click
 * reaches Chromium's own link handling and the host `setWindowOpenHandler` sees the real
 * `disposition`. Never replace this with a direct `web:openBackgroundTab` send — that would test
 * the renderer against a message the guest may never produce.
 */

import { createServer } from 'node:http';
import {
  assert,
  clearSpyCalls,
  closeApp,
  getSpyCalls,
  openSession,
  REPO,
  runScenario,
  spyMain,
} from './harness.mjs';
import { tabInfo, watchStatus } from './middle-click-fixture.mjs';

const ONE = 'Middle Fixture One';
const TWO = 'Middle Fixture Two';
const THREE = 'Middle Fixture Three';

const page = (title, body = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>html,body{margin:0;padding:0}</style></head><body>${body}</body></html>`;

const PAGES = {
  '/': page(
    ONE,
    '<a id="bg" href="/two" style="display:block;width:100vw;height:50vh">two</a>' +
      '<a id="blank" href="/three" target="_blank" style="display:block;width:100vw;height:50vh">three</a>',
  ),
  '/two': page(TWO, '<h1>two</h1>'),
  '/three': page(THREE, '<h1>three</h1>'),
};

async function poll(fn, timeout, interval = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Sends a full down/up click at (x, y) to the guest currently showing `url`. */
function clickGuest(app, url, button, x, y) {
  return app.evaluate(
    ({ webContents }, a) => {
      const g = webContents
        .getAllWebContents()
        .find((w) => w.getType() === 'webview' && w.getURL() === a.url);
      if (!g) return false;
      g.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
      g.sendInputEvent({ type: 'mouseDown', button: a.button, x: a.x, y: a.y, clickCount: 1 });
      g.sendInputEvent({ type: 'mouseUp', button: a.button, x: a.x, y: a.y, clickCount: 1 });
      return true;
    },
    { url, button, x, y },
  );
}

function guestState(app) {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === 'webview')
      .map((w) => ({ url: w.getURL(), loading: w.isLoading() })),
  );
}

runScenario('middle-click-web', async ({ app, page: win, log }) => {
  const server = createServer((req, res) => {
    const body = PAGES[req.url ?? ''];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const FIXTURE = `${ORIGIN}/`;

  try {
    await openSession(win, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
    await spyMain(app, [{ api: 'openExternal' }]);

    await win.click('.omnibar');
    await win.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
    await win.fill('.palette__input', '>open web page');
    await win.waitForSelector('.palette__title', { timeout: 8000 });
    await win.keyboard.press('Enter');
    await win.waitForSelector('.modal__input', { state: 'visible', timeout: 8000 });
    await win.fill('.modal__input', FIXTURE);
    await win.keyboard.press('Enter');

    const loaded = await poll(async () => {
      const guests = await guestState(app);
      return guests.some((g) => g.url === FIXTURE && !g.loading);
    }, 15000);
    assert(
      loaded,
      `fixture guest never finished loading: ${JSON.stringify(await guestState(app))}`,
    );
    const titled = await poll(
      async () => (await tabInfo(win)).some((t) => t.title === ONE && t.active),
      10000,
    );
    assert(titled, `first web tab never adopted "${ONE}": ${JSON.stringify(await tabInfo(win))}`);
    const before = await tabInfo(win);
    log('first web tab loaded', JSON.stringify(before));

    // The region only exists once the feature ships; before that the scenario must still fail
    // on the missing tab (an assertion), not error out here.
    const statusArmed = await watchStatus(win).then(
      () => true,
      () => false,
    );
    await clearSpyCalls(app);

    // #bg fills the top half of the guest viewport.
    assert(await clickGuest(app, FIXTURE, 'middle', 40, 40), 'no guest to middle-click');

    // The page <title> may or may not have loaded yet, so either label identifies the new tab.
    const TWO_URL_TITLE = '127.0.0.1/two';
    const opened = await poll(async () => {
      const tabs = await tabInfo(win);
      return tabs.find((t) => t.title === TWO || t.title === TWO_URL_TITLE) ?? null;
    }, 10000);
    if (!opened) {
      log('DIAGNOSTIC spy calls:', JSON.stringify(await getSpyCalls(app)));
      log('DIAGNOSTIC tabs:', JSON.stringify(await tabInfo(win)));
      log('DIAGNOSTIC guests:', JSON.stringify(await guestState(app)));
    }
    assert(opened, 'middle-click in the guest did not add a web tab for /two');
    assert(!opened.active, 'the background web tab must not be active');
    assert(!opened.preview, 'the background web tab must be pinned, not a preview');

    const tabsAfterMiddle = await tabInfo(win);
    const first = tabsAfterMiddle.find((t) => t.title === ONE);
    assert(first?.active, `first web tab is no longer active: ${JSON.stringify(tabsAfterMiddle)}`);
    assert(
      tabsAfterMiddle.length === before.length + 1,
      `expected exactly one new tab: ${JSON.stringify(tabsAfterMiddle)}`,
    );

    const twoLoaded = await poll(
      async () => (await tabInfo(win)).some((t) => t.title === TWO),
      15000,
    );
    assert(
      twoLoaded,
      `background web tab never adopted "${TWO}": ${JSON.stringify(await tabInfo(win))}`,
    );

    assert(statusArmed, 'no .bg-open-status region to announce the background open');
    // The text lands a frame after the clear, and a hidden window's frames are throttled.
    const announced = await poll(
      () =>
        win.evaluate(() =>
          (window.__statusLog ?? []).some(
            (s) => s.startsWith('Opened ') && s.endsWith(' in a background tab'),
          ),
        ),
      5000,
    );
    assert(
      announced,
      `no background-open announcement: ${JSON.stringify(await win.evaluate(() => window.__statusLog ?? []))}`,
    );

    const middleExternal = (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');
    assert(
      middleExternal.length === 0,
      `middle-click must not reach openExternal: ${JSON.stringify(middleExternal)}`,
    );
    log('PASS: middle-click opened a background web tab, no openExternal ✓');

    const externalCalls = async () =>
      (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');

    // A left-click on target=_blank does nothing at all today: it never reaches the host's
    // window-open handler (measured with a probe handler, for real input and a user-gesture
    // click() alike, independent of this feature — likely the <webview>'s missing
    // `allowpopups`). Pinned as measured; the conductor tracks it as a follow-up.
    const tabsBeforeLeft = await tabInfo(win);
    await clearSpyCalls(app);
    assert(await clickGuest(app, FIXTURE, 'left', 40, 500), 'no guest to left-click');
    await new Promise((r) => setTimeout(r, 2000));
    let tabsNow = await tabInfo(win);
    assert(
      tabsNow.length === tabsBeforeLeft.length,
      `left-click on target=_blank added a tab: ${JSON.stringify(tabsNow)}`,
    );
    assert(
      (await externalCalls()).length === 0,
      `left-click on target=_blank reached openExternal: ${JSON.stringify(await externalCalls())}`,
    );
    log('left-click on target=_blank: no tab, no openExternal (measured behaviour) ✓');

    // A page cannot mint in-app tabs by dispatching Ctrl-clicks from script: without a real
    // gesture in the host's input stream the open never becomes a tab. Wait out the 1 s window
    // left by the real clicks above first.
    await new Promise((r) => setTimeout(r, 1300));
    const tabsBeforeScript = await tabInfo(win);
    await app.evaluate(({ webContents }, u) => {
      const g = webContents
        .getAllWebContents()
        .find((w) => w.getType() === 'webview' && w.getURL() === u);
      return g?.executeJavaScript(
        'document.getElementById("bg").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }))',
        true,
      );
    }, FIXTURE);
    await new Promise((r) => setTimeout(r, 2000));
    tabsNow = await tabInfo(win);
    assert(
      tabsNow.length === tabsBeforeScript.length,
      `a script-dispatched Ctrl-click opened an in-app tab: ${JSON.stringify(tabsNow)}`,
    );
    log(
      `script-dispatched Ctrl-click: no in-app tab ✓ (openExternal calls: ${(await externalCalls()).length})`,
    );

    // Retry mounts a NEW guest; its middle-clicks must still open tabs (review blocker 1).
    const probe = createServer((req, res) => {
      const body = PAGES[req.url ?? ''];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
      res.end(body ?? 'not found');
    });
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port2 = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const URL2 = `http://127.0.0.1:${port2}/`;
    await win.fill('.webview__address', URL2);
    await win.press('.webview__address', 'Enter');
    await win.waitForSelector('.webview__error', { state: 'visible', timeout: 15000 });
    await new Promise((resolve) => probe.listen(port2, '127.0.0.1', resolve));
    try {
      await win.click('.webview__error button');
      const retried = await poll(async () => {
        const guests = await guestState(app);
        return guests.some((g) => g.url === URL2 && !g.loading);
      }, 15000);
      assert(retried, `the retried guest never loaded: ${JSON.stringify(await guestState(app))}`);
      await new Promise((r) => setTimeout(r, 500));
      const tabsBeforeRetryMiddle = await tabInfo(win);
      await clearSpyCalls(app);
      assert(await clickGuest(app, URL2, 'middle', 40, 40), 'no retried guest to middle-click');
      const grew = await poll(
        async () => (await tabInfo(win)).length === tabsBeforeRetryMiddle.length + 1,
        10000,
      );
      tabsNow = await tabInfo(win);
      assert(
        grew,
        `middle-click after Retry opened no tab (the new guest's messages were dropped): ${JSON.stringify(tabsNow)}`,
      );
      assert(
        !tabsNow[tabsNow.length - 1].active,
        `the tab opened after Retry must be in the background: ${JSON.stringify(tabsNow)}`,
      );
      assert(
        (await externalCalls()).length === 0,
        `middle-click after Retry reached openExternal: ${JSON.stringify(await externalCalls())}`,
      );
      log('after Retry (a new guest), middle-click still opens a background tab ✓');
    } finally {
      probe.close();
    }

    await closeApp(app, win);
  } finally {
    server.close();
  }
});

/**
 * web-blank-link — a real left-click (or Enter) on a `target=_blank` link inside an in-app web tab
 * opens a new FOREGROUND web tab; page script alone opens nothing
 * (docs/specs/2026-09-23-web-blank-link.md AC1, AC4, AC5).
 *
 * Input goes to the guest webContents via `sendInputEvent`, so it reaches Chromium's link handling
 * and the host's `input-event` gesture record exactly as a real hand does. Never replace it with a
 * direct `web:openTab` send, and never use `executeJavaScript(..., true)` as the "real" gesture —
 * that is the page-side activation the host gate must NOT trust.
 */

import { assert, clearSpyCalls, closeApp, getSpyCalls, runScenario } from './harness.mjs';
import {
  clickGuest,
  guestScript,
  guestState,
  htmlPage,
  poll,
  serveHtml,
  startWebFixture,
  tabInfo,
} from './middle-click-fixture.mjs';

const ONE = 'Blank Fixture One';
const TITLES = {
  '/three': 'Blank Fixture Three',
  '/four': 'Blank Fixture Four',
  '/five': 'Blank Fixture Five',
  '/six': 'Blank Fixture Six',
  '/seven': 'Blank Fixture Seven',
  '/eight': 'Blank Fixture Eight',
  '/nine': 'Blank Fixture Nine',
};

const PAGES = {
  '/': htmlPage(
    ONE,
    '<a id="blank" href="/three" target="_blank">three</a>' +
      '<a id="blank4" href="/four" target="_blank">four</a>' +
      '<button id="two-opens" onclick="window.open(\'/five\'); window.open(\'/six\')">opens</button>' +
      '<div id="pad">pad</div>' +
      '<button id="mod-opens" onclick="window.open(\'/eight\'); window.open(\'/nine\')" ' +
      "onauxclick=\"window.open('/eight'); window.open('/nine')\">mod opens</button>",
    'a,button,div{display:block;width:100vw;height:80px;margin:0}',
  ),
  ...Object.fromEntries(Object.entries(TITLES).map(([p, t]) => [p, htmlPage(t, `<h1>${t}</h1>`)])),
};
const Y = { blank: 40, twoOpens: 200, pad: 280, modOpens: 360 };

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Focuses `#id` from page script, then presses a real Enter. */
const pressEnterOn = (app, url, id) =>
  app.evaluate(
    async ({ webContents }, a) => {
      const g = webContents
        .getAllWebContents()
        .find((w) => w.getType() === 'webview' && w.getURL() === a.url);
      if (!g) return false;
      await g.executeJavaScript(`document.getElementById(${JSON.stringify(a.id)}).focus()`);
      g.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      g.sendInputEvent({ type: 'char', keyCode: '\r' });
      g.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      return true;
    },
    { url, id },
  );

const windowCount = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

runScenario('web-blank-link', async ({ app, page: win, log }) => {
  const { server, origin } = await serveHtml(PAGES);
  const FIXTURE = `${origin}/`;
  const titleFor = (p) => [TITLES[p], `127.0.0.1${p}`];
  const externalCalls = async () =>
    (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');

  const activateFixtureTab = async () => {
    await win
      .locator('.tabbar [role="tab"]', {
        has: win.locator('span', { hasText: new RegExp(`^${ONE}$`) }),
      })
      .click();
    const shown = await poll(
      async () => (await tabInfo(win)).some((t) => t.title === ONE && t.active),
      5000,
    );
    assert(shown, `could not re-activate the fixture tab: ${JSON.stringify(await tabInfo(win))}`);
    await settle(400);
  };

  /** Asserts exactly one new tab for `path`, and that it is the active one. */
  const expectForegroundTab = async (before, path, what) => {
    const opened = await poll(async () => {
      const tabs = await tabInfo(win);
      return tabs.find((t) => titleFor(path).includes(t.title)) ?? null;
    }, 10000);
    if (!opened) {
      log('DIAGNOSTIC spy:', JSON.stringify(await getSpyCalls(app)));
      log('DIAGNOSTIC guests:', JSON.stringify(await guestState(app)));
    }
    assert(
      opened,
      `${what} did not add a web tab for ${path}: ${JSON.stringify(await tabInfo(win))}`,
    );
    const tabs = await tabInfo(win);
    assert(
      tabs.length === before.length + 1,
      `${what}: expected exactly one new tab: ${JSON.stringify(tabs)}`,
    );
    const active = tabs.filter((t) => t.active);
    assert(
      active.length === 1 && titleFor(path).includes(active[0].title),
      `${what}: the new tab must be the active one: ${JSON.stringify(tabs)}`,
    );
    assert(!active[0].preview, `${what}: a web tab is never a preview: ${JSON.stringify(tabs)}`);
    const ext = await externalCalls();
    assert(ext.length === 0, `${what} reached openExternal: ${JSON.stringify(ext)}`);
  };

  try {
    await startWebFixture(app, win, FIXTURE, ONE);
    const windowsAtStart = await windowCount(app);

    // AC4: page script with page-side activation but no real input — nothing opens anywhere.
    await clearSpyCalls(app);
    const beforeScript = await tabInfo(win);
    await guestScript(app, FIXTURE, "window.open('/seven')");
    await guestScript(app, FIXTURE, "window.open('/seven', 'x', 'width=300,height=200')");
    await guestScript(app, FIXTURE, "document.getElementById('blank').click()");
    await settle(1500);
    let tabs = await tabInfo(win);
    assert(
      tabs.length === beforeScript.length,
      `page script alone opened a tab: ${JSON.stringify(tabs)}`,
    );
    assert(
      (await externalCalls()).length === 0,
      `page script alone reached openExternal: ${JSON.stringify(await externalCalls())}`,
    );
    assert(
      (await windowCount(app)) === windowsAtStart,
      `page script created a BrowserWindow (${await windowCount(app)} vs ${windowsAtStart})`,
    );
    log('script window.open ×2 and a.click(): no tab, no openExternal, no window ✓');

    // AC1: a real left-click on target=_blank → one new active tab in the same strip.
    await clearSpyCalls(app);
    const beforeLeft = await tabInfo(win);
    assert(await clickGuest(app, FIXTURE, 'left', 40, Y.blank), 'no guest to left-click');
    await expectForegroundTab(beforeLeft, '/three', 'a real left-click on target=_blank');
    log('real left-click on target=_blank: new foreground web tab, no openExternal ✓');

    // AC5: real Enter on a focused target=_blank link.
    await activateFixtureTab();
    await clearSpyCalls(app);
    const beforeEnter = await tabInfo(win);
    assert(await pressEnterOn(app, FIXTURE, 'blank4'), 'no guest to press Enter in');
    await expectForegroundTab(beforeEnter, '/four', 'a real Enter on target=_blank');
    log('real Enter on target=_blank: new foreground web tab ✓');

    // One real click buys one open: a handler that opens twice yields exactly one tab.
    await activateFixtureTab();
    await clearSpyCalls(app);
    const beforeTwo = await tabInfo(win);
    assert(
      await clickGuest(app, FIXTURE, 'left', 40, Y.twoOpens),
      'no guest to click the two-opens button',
    );
    await expectForegroundTab(beforeTwo, '/five', 'one click with two window.open calls');
    await settle(1000);
    tabs = await tabInfo(win);
    assert(
      tabs.length === beforeTwo.length + 1 && !tabs.some((t) => titleFor('/six').includes(t.title)),
      `the second window.open of one gesture must be denied: ${JSON.stringify(tabs)}`,
    );
    log('one gesture, two window.open calls: exactly one tab ✓');

    // A stale gesture can't be banked: a real click, then a script open 500 ms later.
    await activateFixtureTab();
    await clearSpyCalls(app);
    const beforeStale = await tabInfo(win);
    assert(await clickGuest(app, FIXTURE, 'left', 40, Y.pad), 'no guest to click the pad');
    await settle(500);
    await guestScript(app, FIXTURE, "window.open('/seven')");
    await settle(1500);
    tabs = await tabInfo(win);
    assert(
      tabs.length === beforeStale.length,
      `a window.open 500 ms after a click opened a tab: ${JSON.stringify(tabs)}`,
    );
    assert(
      (await externalCalls()).length === 0,
      `stale open reached openExternal: ${JSON.stringify(await externalCalls())}`,
    );
    log('window.open 500 ms after a real click: denied ✓');

    // During a real Ctrl or middle click, Blink gives a page's window.open the background-tab
    // disposition. One real gesture still buys at most one open (spec §3, review blocker).
    const inAppOf = (list, ...paths) =>
      list.filter((t) => paths.some((p) => titleFor(p).includes(t.title)));
    await settle(500);
    await clearSpyCalls(app);
    const beforeCtrl = await tabInfo(win);
    assert(
      await clickGuest(app, FIXTURE, 'left', 40, Y.modOpens, ['control']),
      'no guest to Ctrl-click',
    );
    await poll(async () => (await externalCalls()).length > 0, 3000);
    await settle(1500);
    tabs = await tabInfo(win);
    const ctrlExternal = await externalCalls();
    log('real Ctrl+click on a two-window.open button: openExternal calls', ctrlExternal.length);
    assert(
      ctrlExternal.length === 1,
      `one real Ctrl+click must launch the system browser exactly once: ${JSON.stringify(ctrlExternal)}`,
    );
    assert(
      tabs.length === beforeCtrl.length && inAppOf(tabs, '/eight', '/nine').length === 0,
      `a real Ctrl+click opened an in-app tab: ${JSON.stringify(tabs)}`,
    );
    log('real Ctrl+click, two window.open calls: at most one openExternal, no tab ✓');

    await settle(500);
    await clearSpyCalls(app);
    const beforeMiddle = await tabInfo(win);
    assert(
      await clickGuest(app, FIXTURE, 'middle', 40, Y.modOpens),
      'no guest to middle-click the two-opens button',
    );
    const middleOpened = await poll(
      async () => inAppOf(await tabInfo(win), '/eight').length > 0,
      10000,
    );
    await settle(1500);
    tabs = await tabInfo(win);
    if (!middleOpened) log('DIAGNOSTIC spy:', JSON.stringify(await getSpyCalls(app)));
    assert(
      tabs.length === beforeMiddle.length + 1 &&
        inAppOf(tabs, '/eight').length === 1 &&
        inAppOf(tabs, '/nine').length === 0,
      `a real middle-click on a two-window.open button must add exactly one tab: ${JSON.stringify(tabs)}`,
    );
    assert(
      !inAppOf(tabs, '/eight')[0].active,
      `the middle-click tab must open in the background: ${JSON.stringify(tabs)}`,
    );
    assert(
      (await externalCalls()).length === 0,
      `a real middle-click reached openExternal: ${JSON.stringify(await externalCalls())}`,
    );
    log('real middle-click, two window.open calls: one background tab, no openExternal ✓');

    await closeApp(app, win);
  } finally {
    server.close();
  }
});

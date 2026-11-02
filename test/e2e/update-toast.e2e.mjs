/**
 * The update notification is one persistent item in the window's single floating stack (spec
 * 2026-11-02 sidebar-agent-tree §7 "Floating update notifications", AC11; plan S0 contract).
 *
 * The host's own `updateStatus` messages are delivered on the window's `to-webview` channel, as
 * electron/updater.ts broadcasts them (the updater itself is a no-op unpackaged). Checked:
 *  - checking / up-to-date / error show no card; available → downloading → ready update ONE
 *    `.update-card[data-update-toast]` node in place inside the one `[data-toast-stack]` portal;
 *  - the card keeps one bottom/right anchor for every state, with the sidebar collapsed, the
 *    right panel hidden, and the board / canvas center views; it overlays the status bar;
 *  - showing it moves no workbench rectangle (topbar, sidebar, center, right panel, status bar);
 *  - no card inside `.sidebar`; the percent is a clamped number with a matching progressbar;
 *  - a generic toast shares the same stack, above the update item;
 *  - Dismiss hides it until the next `ready`; Relaunch posts the existing `updateRelaunch`,
 *    captured at the host so nothing installs or quits; no "What's new" link.
 */
import { assert, runCommand, runScenario } from './harness.mjs';

const VERSION = '9.9.9';
const CARD = '.update-card[data-update-toast]';
const STACK = '[data-toast-stack]';

/** Deliver an updateStatus to every window exactly as the updater's broadcast does. */
const sendUpdate = (app, msg) =>
  app.evaluate(({ BrowserWindow }, m) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('to-webview', { type: 'updateStatus', ...m });
  }, msg);

/**
 * Wrap the host's `to-host` listeners: record every message whose type is in `record`, and keep
 * those in `swallow` from reaching the real handler (so `updateRelaunch` never quits the app).
 * Candidate for harness.mjs (terminal-local-font has the same tap).
 */
async function tapHostMessages(app, { record, swallow = [] }) {
  await app.evaluate(
    ({ ipcMain }, opts) => {
      if (globalThis.__e2eHostTap) {
        Object.assign(globalThis.__e2eHostTap, opts);
        return;
      }
      const tap = { ...opts, seen: [] };
      globalThis.__e2eHostTap = tap;
      const real = ipcMain.listeners('to-host');
      ipcMain.removeAllListeners('to-host');
      ipcMain.on('to-host', (e, m) => {
        if (m && tap.record.includes(m.type)) tap.seen.push({ at: Date.now(), msg: m });
        if (m && tap.swallow.includes(m.type)) return;
        for (const l of real) l(e, m);
      });
    },
    { record, swallow },
  );
}
const hostSeen = (app) => app.evaluate(() => globalThis.__e2eHostTap?.seen ?? []);

/** Count the updateStatus messages the renderer has received, so a send can be awaited. */
const armUpdateCounter = (page) =>
  page.evaluate(() => {
    if (window.__updSeen !== undefined) return;
    window.__updSeen = 0;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'updateStatus') window.__updSeen++;
    });
  });

/** Send and wait until the renderer has received it and painted twice since. */
async function deliver(app, page, msg) {
  const before = await page.evaluate(() => window.__updSeen);
  await sendUpdate(app, msg);
  await page.waitForFunction((n) => window.__updSeen > n, before, { timeout: 10000 });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** The rectangles of every workbench region that must not move for a floating notification. */
const workbenchRects = (page) =>
  page.evaluate(() => {
    const pick = {
      topbar: '.topbar',
      sidebar: '.sidebar',
      center: 'main.centerpane',
      rightPane: '#right-pane',
      statusBar: 'footer[data-status-bar]',
    };
    const out = {};
    for (const [k, sel] of Object.entries(pick)) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      out[k] = r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10) : null;
    }
    return out;
  });

function assertNoShift(before, after, what) {
  for (const k of Object.keys(before)) {
    assert(
      JSON.stringify(before[k]) === JSON.stringify(after[k]),
      `${what}: ${k} moved ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`,
    );
  }
}

/** Facts about the card and its stack, read in one tick. */
const cardFacts = (page) =>
  page.evaluate(
    ({ card, stack }) => {
      const cards = document.querySelectorAll(card);
      const el = cards[0];
      const stacks = document.querySelectorAll(stack);
      if (!el) return { count: 0, stacks: stacks.length };
      const r = el.getBoundingClientRect();
      const bar = el.querySelector('[role="progressbar"]');
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return {
        count: cards.length,
        stacks: stacks.length,
        state: el.getAttribute('data-update-state'),
        marked: el.__e2eMark === true,
        inStack: !!el.closest(stack),
        stackInBody: el.closest(stack)?.parentElement === document.body,
        stackRole: el.closest(stack)?.getAttribute('role'),
        stackLabel: el.closest(stack)?.getAttribute('aria-label'),
        inSidebar: document.querySelectorAll(`.sidebar ${card}, .sidebar .update-card`).length,
        right: Math.round((window.innerWidth - r.right) * 10) / 10,
        bottom: Math.round((window.innerHeight - r.bottom) * 10) / 10,
        inset: parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--toast-inset'),
        ),
        onTop: !!top && el.contains(top),
        status: el.querySelector('[role="status"]')?.textContent ?? null,
        percent: el.querySelector('.update-card__percent')?.textContent ?? null,
        bar: bar
          ? {
              label: bar.getAttribute('aria-label'),
              min: bar.getAttribute('aria-valuemin'),
              max: bar.getAttribute('aria-valuemax'),
              now: bar.getAttribute('aria-valuenow'),
            }
          : null,
        dismiss: !!el.querySelector('button[aria-label="Dismiss update"]'),
        relaunch: [...el.querySelectorAll('button')].some(
          (b) => b.textContent?.trim() === 'Relaunch to update',
        ),
        links: el.querySelectorAll('a').length,
        whatsNew: /what['’]s new|release notes/i.test(el.textContent ?? ''),
      };
    },
    { card: CARD, stack: STACK },
  );

const blur = (page) =>
  page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

runScenario('update-toast', async ({ app, page, log }) => {
  await tapHostMessages(app, { record: ['updateRelaunch'], swallow: ['updateRelaunch'] });
  await page.waitForSelector(STACK, { state: 'attached', timeout: 20000 });
  await armUpdateCounter(page);
  await blur(page);

  const stackFacts = await page.evaluate((stack) => {
    const all = document.querySelectorAll(stack);
    const s = all[0];
    return {
      count: all.length,
      inBody: s?.parentElement === document.body,
      role: s?.getAttribute('role'),
      label: s?.getAttribute('aria-label'),
      isToasts: s?.classList.contains('toasts'),
    };
  }, STACK);
  assert(stackFacts.count === 1, `one floating stack (got ${stackFacts.count})`);
  assert(
    stackFacts.inBody && stackFacts.isToasts && stackFacts.role === 'region',
    `the stack is the body-portalled .toasts region (${JSON.stringify(stackFacts)})`,
  );
  assert(stackFacts.label === 'Notifications', 'the stack is labelled "Notifications"');
  assert(
    await page.locator('footer[data-status-bar]').isVisible(),
    'the status bar (footer[data-status-bar]) is mounted beneath the toast outlet',
  );

  // ── Non-card states ───────────────────────────────────────────────────────
  for (const status of ['checking', 'up-to-date']) {
    await deliver(app, page, { status });
    assert((await page.locator(CARD).count()) === 0, `${status} shows no card`);
  }
  await deliver(app, page, { status: 'error', message: 'e2e: no feed' });
  assert((await page.locator(CARD).count()) === 0, 'error shows no card');
  const baseline = await workbenchRects(page);
  log(`workbench before the card: ${JSON.stringify(baseline)}`);

  // ── available → downloading → ready: one node, one anchor, no shift ───────
  await deliver(app, page, { status: 'available', version: VERSION, releaseNotes: 'notes' });
  await page.waitForSelector(CARD, { state: 'visible', timeout: 5000 });
  await page.evaluate((card) => {
    document.querySelector(card).__e2eMark = true;
  }, CARD);
  const available = await cardFacts(page);
  log(`available: ${JSON.stringify(available)}`);
  assert(available.count === 1 && available.stacks === 1, 'one card in one stack');
  assert(available.state === 'available', `data-update-state available (${available.state})`);
  assert(available.inStack && available.stackInBody, 'the card lives in the portalled stack');
  assert(available.inSidebar === 0, 'no update card inside the sidebar');
  assert(
    available.status === `Updating to v${VERSION}…`,
    `available keeps today's label (got ${JSON.stringify(available.status)})`,
  );
  assert(available.dismiss, 'available has Dismiss update');
  assert(available.onTop, 'the card is the topmost element at its centre');
  assert(
    Math.abs(available.right - available.inset) <= 1 &&
      Math.abs(available.bottom - available.inset) <= 1,
    `the card uses equal window insets (right ${available.right}, bottom ${available.bottom}, inset ${available.inset})`,
  );
  assertNoShift(baseline, await workbenchRects(page), 'showing the available card');
  const anchor = { right: available.right, bottom: available.bottom };
  const sameAnchor = (f, what) =>
    assert(
      Math.abs(f.right - anchor.right) <= 0.5 && Math.abs(f.bottom - anchor.bottom) <= 0.5,
      `${what}: anchor moved from right ${anchor.right}/bottom ${anchor.bottom} to ${f.right}/${f.bottom}`,
    );

  const percentCases = [
    [42, 42],
    [140, 100],
    [-5, 0],
    [Number.NaN, 0],
    [undefined, 0],
    [57.6, 58],
  ];
  for (const [sent, want] of percentCases) {
    await deliver(app, page, {
      status: 'downloading',
      version: VERSION,
      ...(sent === undefined ? {} : { percent: sent }),
    });
    const f = await cardFacts(page);
    const what = `downloading ${String(sent)}`;
    assert(f.count === 1 && f.marked, `${what}: the same card node updated in place`);
    assert(f.state === 'downloading', `${what}: data-update-state downloading (${f.state})`);
    assert(
      f.bar?.label === 'Update download' && f.bar.min === '0' && f.bar.max === '100',
      `${what}: progressbar "Update download" 0–100 (${JSON.stringify(f.bar)})`,
    );
    assert(f.bar.now === String(want), `${what}: aria-valuenow ${want} (got ${f.bar.now})`);
    assert(
      new RegExp(`(^|\\D)${want}(\\D|$)`).test(f.percent ?? '') && /%/.test(f.percent ?? ''),
      `${what}: numeric percent text shows ${want}% (got ${JSON.stringify(f.percent)})`,
    );
    assert(
      f.status === `Updating to v${VERSION}…`,
      `${what}: lifecycle text unchanged by a tick (got ${JSON.stringify(f.status)})`,
    );
    sameAnchor(f, what);
  }
  assertNoShift(baseline, await workbenchRects(page), 'the downloading card');
  log('downloading: one node, clamped percent + progressbar, anchor fixed ✓');

  // ── Coexistence with a generic toast ──────────────────────────────────────
  await blur(page);
  await page.keyboard.press('Control+Z');
  const toast = page.locator(`${STACK} .toast`, { hasText: 'Nothing to undo.' });
  await toast.waitFor({ state: 'visible', timeout: 5000 });
  const together = await page.evaluate(
    ({ card, stack }) => {
      const t = [...document.querySelectorAll(`${stack} .toast`)].find((x) =>
        x.textContent?.includes('Nothing to undo.'),
      );
      const c = document.querySelector(card);
      return {
        stacks: document.querySelectorAll(stack).length,
        sameStack: !!t && !!c && t.closest(stack) === c.closest(stack),
        toastAbove:
          !!t && !!c && t.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 0.5,
      };
    },
    { card: CARD, stack: STACK },
  );
  assert(together.stacks === 1, 'a generic toast opens no second outlet');
  assert(together.sameStack, 'the generic toast shares the update card’s stack');
  assert(together.toastAbove, 'the generic toast stacks above the update item');
  sameAnchor(await cardFacts(page), 'with a generic toast');
  log('generic toast shares the stack above the update item ✓');

  // ── The anchor holds across layout changes ────────────────────────────────
  await blur(page);
  await page.keyboard.press('Control+B');
  await page.waitForSelector('.panel--sessions', { state: 'detached', timeout: 5000 });
  sameAnchor(await cardFacts(page), 'sidebar collapsed');
  await blur(page);
  await page.keyboard.press('Control+B');
  await page.waitForSelector('.panel--sessions', { state: 'attached', timeout: 5000 });
  sameAnchor(await cardFacts(page), 'sidebar expanded');

  const panelOpen = await page.locator('#right-pane').isVisible();
  await runCommand(page, panelOpen ? 'Hide Explorer' : 'Show Explorer');
  await page.waitForSelector('#right-pane', {
    state: panelOpen ? 'detached' : 'visible',
    timeout: 5000,
  });
  sameAnchor(await cardFacts(page), `right panel ${panelOpen ? 'hidden' : 'shown'}`);
  await runCommand(page, panelOpen ? 'Show Explorer' : 'Hide Explorer');
  await page.waitForSelector('#right-pane', {
    state: panelOpen ? 'visible' : 'detached',
    timeout: 5000,
  });
  sameAnchor(await cardFacts(page), 'right panel restored');

  await runCommand(page, 'Open feature board');
  await page.waitForSelector('.board', { state: 'visible', timeout: 15000 });
  let f = await cardFacts(page);
  sameAnchor(f, 'board view');
  assert(f.onTop, 'the card floats above the board');
  await runCommand(page, 'Open architecture canvas');
  await page.waitForSelector('.arch', { state: 'visible', timeout: 15000 });
  f = await cardFacts(page);
  sameAnchor(f, 'canvas view');
  assert(f.onTop, 'the card floats above the canvas');
  await runCommand(page, 'Open editor');
  await page.waitForFunction(() => !document.querySelector('.board, .arch'), null, {
    timeout: 10000,
  });
  sameAnchor(await cardFacts(page), 'back on the editor');
  assertNoShift(baseline, await workbenchRects(page), 'after the layout round trip');
  log('anchor fixed across sidebar, right panel, board and canvas ✓');

  // ── Dismiss, and the ready reset ──────────────────────────────────────────
  await page.locator(`${CARD} button[aria-label="Dismiss update"]`).click();
  await page.waitForSelector(CARD, { state: 'detached', timeout: 5000 });
  await deliver(app, page, { status: 'downloading', version: VERSION, percent: 90 });
  assert(
    (await page.locator(CARD).count()) === 0,
    'a dismissed update stays hidden while downloading',
  );
  await deliver(app, page, { status: 'ready', version: VERSION, releaseNotes: 'notes' });
  await page.waitForSelector(CARD, { state: 'visible', timeout: 5000 });
  const ready = await cardFacts(page);
  log(`ready: ${JSON.stringify(ready)}`);
  assert(ready.count === 1 && ready.stacks === 1, 'ready: one card in one stack');
  assert(ready.state === 'ready', `ready: data-update-state ready (${ready.state})`);
  assert(ready.status === `v${VERSION} ready`, `ready label (got ${JSON.stringify(ready.status)})`);
  assert(ready.relaunch, 'ready offers Relaunch to update');
  assert(ready.dismiss, 'ready keeps Dismiss update');
  assert(ready.bar === null && ready.percent === null, 'ready shows no progress');
  assert(ready.links === 0 && !ready.whatsNew, 'no What’s new / release-notes link');
  assert(ready.inSidebar === 0, 'ready: no update card inside the sidebar');
  sameAnchor(ready, 'ready (taller card grows upward)');
  assert(
    Math.abs(ready.right - ready.inset) <= 1 && Math.abs(ready.bottom - ready.inset) <= 1,
    'ready: the card uses equal window insets',
  );
  assertNoShift(baseline, await workbenchRects(page), 'the ready card');

  // ── Relaunch posts the existing message, and nothing installs ─────────────
  await page.locator(CARD).getByRole('button', { name: 'Relaunch to update' }).click();
  const deadline = Date.now() + 5000;
  let seen = await hostSeen(app);
  while (!seen.some((x) => x.msg.type === 'updateRelaunch') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    seen = await hostSeen(app);
  }
  // Settle a beat past the first arrival so a double post would be counted too.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const relaunched = (await hostSeen(app)).filter((x) => x.msg.type === 'updateRelaunch');
  assert(
    relaunched.length === 1,
    `Relaunch to update posts updateRelaunch once (got ${relaunched.length})`,
  );
  assert(
    JSON.stringify(relaunched[0].msg) === JSON.stringify({ type: 'updateRelaunch' }),
    `the message is the existing { type: 'updateRelaunch' } (got ${JSON.stringify(relaunched[0].msg)})`,
  );
  assert(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0),
    'the captured relaunch neither quit nor installed',
  );
  log('ready: Relaunch posts updateRelaunch (captured), dismiss/reset, no What’s new ✓');

  // ── Leaving the visible states hides the card again ───────────────────────
  for (const [status, extra] of [
    ['error', { message: 'e2e: feed gone' }],
    ['checking', {}],
    ['up-to-date', {}],
  ]) {
    await deliver(app, page, { status: 'ready', version: VERSION });
    await page.waitForSelector(CARD, { state: 'visible', timeout: 5000 });
    await deliver(app, page, { status, ...extra });
    assert((await page.locator(CARD).count()) === 0, `${status} after ready shows no card`);
  }
  log('checking / up-to-date / error show no card ✓');
});

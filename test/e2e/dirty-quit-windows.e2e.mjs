/**
 * Dirty-editor quit guard across windows and on update relaunch
 * (docs/specs/2026-09-28-dirty-quit-guard.md): a non-last dirty window, two windows where the
 * second cancels, two windows closed back to back (S4), and the update relaunch.
 * `DIRTY_QUIT_PHASE=<phase>` runs one phase.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirty } from './auto-save-helpers.mjs';
import {
  assert,
  clickDialog,
  dirtyDialog,
  dirtyFile,
  makeRoot,
  ORIGINAL,
  runPhases,
  sleep,
  waitExit,
  windowCount,
} from './dirty-quit-helpers.mjs';
import { answerQuitAsks, launchApp, openSession, REPO } from './harness.mjs';

const disk = (root) => readFileSync(join(root, 'a.ts'), 'utf8');
const scrim = (page) => page.locator('.quit-scrim');

async function newWindow(app, page) {
  const before = await app.evaluate((e) => e.BrowserWindow.getAllWindows().map((w) => w.id));
  const next = app.waitForEvent('window', { timeout: 20000 });
  await page.evaluate(() => window.agentDeck.post({ type: 'win:new' }));
  const page2 = await next;
  await page2.waitForLoadState('domcontentloaded');
  await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  const id = await app.evaluate(
    (e, ids) =>
      e.BrowserWindow.getAllWindows()
        .map((w) => w.id)
        .find((x) => !ids.includes(x)),
    before,
  );
  return { page: page2, id };
}

const closeWindow = (app, id) => app.evaluate((e, wid) => e.BrowserWindow.fromId(wid)?.close(), id);

/** Which of `pages` shows the unsaved-files dialog first. */
async function firstAsked(pages, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const p of pages) {
      if ((await p.locator('.confirm.confirm--files').count()) > 0) return p;
    }
    await sleep(100);
  }
  assert(false, 'no window showed the unsaved-files dialog');
}

await runPhases('dirty-quit-windows', {
  async nonLast({ log, track }) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-dirtyquit-ud-'));
    writeFileSync(
      join(userDataDir, 'agents.json'),
      JSON.stringify([
        {
          id: 'quick-exit',
          label: 'quick-exit',
          command: 'cmd.exe',
          args: ['/c', 'exit 0'],
          icon: 'terminal',
          color: 'green',
          cwdStrategy: 'workspaceFolder',
        },
      ]),
    );
    const launched = await launchApp({ userDataDir });
    track(launched);
    const { app, page } = launched;
    const root = makeRoot();
    const w2 = await newWindow(app, page);
    const sid = await openSession(w2.page, { path: root, agentId: 'quick-exit' });
    await w2.page.waitForFunction(
      (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'exited',
      sid,
      { timeout: 15000 },
    );
    await dirtyFile(w2.page);
    await closeWindow(app, w2.id);
    await dirtyDialog(w2.page);
    assert(
      (await page.locator('[role="alertdialog"]').count()) === 0,
      'window 1 shows no dialog for window 2 closing',
    );
    await clickDialog(w2.page, 'Cancel');
    await sleep(800);
    assert((await windowCount(app)) === 2, 'window 2 stays after Cancel');
    await closeWindow(app, w2.id);
    await dirtyDialog(w2.page);
    await clickDialog(w2.page, "Don't Save");
    const deadline = Date.now() + 8000;
    while ((await windowCount(app)) !== 1 && Date.now() < deadline) await sleep(150);
    assert((await windowCount(app)) === 1, "one window remains after Don't Save");
    assert(disk(root) === ORIGINAL, "disk unchanged after Don't Save");
    log('nonLast ✓');
  },

  async twoWindows({ log, track }) {
    const launched = await launchApp();
    track(launched);
    const { app, page } = launched;
    const root1 = makeRoot();
    const root2 = makeRoot();
    await openSession(page, { path: root1 });
    await dirtyFile(page);
    const w2 = await newWindow(app, page);
    await openSession(w2.page, { path: root2 });
    await dirtyFile(w2.page);
    await app.evaluate(({ app: a }) => a.quit());
    const first = await firstAsked([page, w2.page]);
    const second = first === page ? w2.page : page;
    const [firstRoot, secondRoot] = first === page ? [root1, root2] : [root2, root1];
    await clickDialog(first, 'Save All');
    await scrim(first).waitFor({ state: 'visible', timeout: 8000 });
    await dirtyDialog(second);
    await clickDialog(second, 'Cancel');
    await scrim(first).waitFor({ state: 'detached', timeout: 8000 });
    assert((await windowCount(app)) === 2, 'both windows open after the second window cancels');
    assert(disk(firstRoot).startsWith('EDIT'), "the first window's file was saved");
    assert(disk(secondRoot) === ORIGINAL, "the second window's file is untouched");
    assert(await isDirty(second, 'a.ts'), "the second window's file is still dirty");
    log('twoWindows ✓');
  },

  async closeAll({ log, track }) {
    const launched = await launchApp();
    track(launched);
    const { app, page } = launched;
    await openSession(page, { path: REPO });
    const w2 = await newWindow(app, page);
    await openSession(w2.page, { path: REPO });
    await answerQuitAsks(app, { proceed: true });
    // Recorded as the host sends them: an ask to a window already unloading never reaches its
    // renderer, so the renderer-side answerer can't see a second ask to the window that closed.
    const sent = [];
    app.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('__hostAsk ')) sent.push(JSON.parse(text.slice('__hostAsk '.length)));
    });
    // Closed in creation order: a quit asks unfocused windows in that order too, so the window that
    // already answered is first in line while it is still unloading (the order that exposes S4).
    const ids = await app.evaluate((e) =>
      e.BrowserWindow.getAllWindows()
        .sort((a, b) => a.id - b.id)
        .map((w) => {
          const send = w.webContents.send.bind(w.webContents);
          w.webContents.send = (channel, msg, ...rest) => {
            if (msg?.type === 'confirmQuit')
              console.log(`__hostAsk ${JSON.stringify({ windowId: w.id, reason: msg.reason })}`);
            return send(channel, msg, ...rest);
          };
          return w.id;
        }),
    );
    await app.evaluate((e, order) => {
      for (const id of order) e.BrowserWindow.fromId(id)?.close();
    }, ids);
    assert(await waitExit(app, 15000), 'the app exits after both windows close (S4)');
    // The second close queues behind the first, then finds itself the last window and becomes a
    // quit — which must not ask the window that already answered its own close again (plan T6.1).
    const expected = [
      { windowId: ids[0], reason: 'windowClose' },
      { windowId: ids[1], reason: 'quit' },
    ];
    assert(
      JSON.stringify(sent) === JSON.stringify(expected),
      `each window asked exactly once, in close order: ${JSON.stringify(sent)}`,
    );
    log(`closeAll ✓ asks=${JSON.stringify(sent)}`);
  },

  async update({ log, track }) {
    const launched = await launchApp();
    track(launched);
    const { app, page } = launched;
    const root = makeRoot();
    await openSession(page, { path: root });
    await dirtyFile(page);
    await page.evaluate(() => window.agentDeck.post({ type: 'updateRelaunch' }));
    let dialog = await dirtyDialog(page);
    assert(
      (await dialog.textContent()).includes('Conduit will relaunch to install the update.'),
      'the update line is shown',
    );
    await clickDialog(page, 'Cancel');
    await sleep(500);
    assert((await scrim(page).count()) === 0, 'no scrim after Cancel');
    assert((await windowCount(app)) === 1, 'app alive after Cancel');
    await page.evaluate(() => window.agentDeck.post({ type: 'updateRelaunch' }));
    dialog = await dirtyDialog(page);
    await clickDialog(page, 'Save All');
    await scrim(page).waitFor({ state: 'visible', timeout: 8000 });
    assert(disk(root).startsWith('EDIT'), 'the file was saved before the relaunch');
    // Unpackaged, quitAndInstall doesn't quit: the 5 s grant expires and unlocks the window.
    await scrim(page).waitFor({ state: 'detached', timeout: 8000 });
    assert((await windowCount(app)) === 1, 'app alive once the grant expired');
    log('update ✓');
  },
});

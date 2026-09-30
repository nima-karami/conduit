/**
 * Dirty-editor guard on session close and session move (docs/specs/2026-09-28-dirty-quit-guard.md
 * §5). Runs with confirmCloseRunning off: unsaved files must ask regardless (A9).
 * `DIRTY_QUIT_PHASE=<phase>` runs one phase.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirty } from './auto-save-helpers.mjs';
import {
  assert,
  clickDialog,
  dirtyDialog,
  launchDirty,
  ORIGINAL,
  runPhases,
  sleep,
  windowCount,
} from './dirty-quit-helpers.mjs';

async function confirmCloseRunningOff(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let sent = false;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          if (!sent) {
            sent = true;
            window.agentDeck.post({
              type: 'updateSettings',
              settings: { ...m.settings, confirmCloseRunning: false },
            });
          }
          if (m.settings?.confirmCloseRunning === false) {
            off();
            resolve();
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
  );
}

const card = (page, sid) => page.locator(`[data-sessionid="${sid}"]`).first();
const listed = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).some((s) => s.id === id), sid);

async function closeFromRail(page, sid) {
  await card(page, sid).hover();
  await card(page, sid).locator('.session__kill').click();
}

async function moveToNewWindow(page, sid) {
  await card(page, sid).click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: 'Move to new window' }).click();
}

await runPhases('dirty-session-close', {
  async close({ log, track }) {
    const d = await launchDirty();
    track(d.launched);
    await confirmCloseRunningOff(d.page);
    await closeFromRail(d.page, d.sid);
    await dirtyDialog(d.page);
    await clickDialog(d.page, 'Cancel');
    await sleep(500);
    assert(await listed(d.page, d.sid), 'session still listed after Cancel');
    assert(await isDirty(d.page, 'a.ts'), 'a.ts still dirty after Cancel');
    await closeFromRail(d.page, d.sid);
    await dirtyDialog(d.page);
    await clickDialog(d.page, "Don't Save");
    await d.page.waitForFunction(
      (id) => !(window.__sessions || []).some((s) => s.id === id),
      d.sid,
      { timeout: 10000 },
    );
    const disk = readFileSync(join(d.root, 'a.ts'), 'utf8');
    assert(disk === ORIGINAL, `disk unchanged after Don't Save: ${JSON.stringify(disk)}`);
    log('close ✓');
  },

  async move({ log, track }) {
    const d = await launchDirty();
    track(d.launched);
    await moveToNewWindow(d.page, d.sid);
    await dirtyDialog(d.page);
    await clickDialog(d.page, 'Cancel');
    await sleep(800);
    assert((await windowCount(d.app)) === 1, 'still one window after Cancel');
    assert(await listed(d.page, d.sid), 'session still owned by this window after Cancel');
    assert(await isDirty(d.page, 'a.ts'), 'a.ts still dirty after Cancel');
    await moveToNewWindow(d.page, d.sid);
    await dirtyDialog(d.page);
    await clickDialog(d.page, 'Save All');
    const deadline = Date.now() + 10000;
    while ((await windowCount(d.app)) !== 2 && Date.now() < deadline) await sleep(150);
    assert((await windowCount(d.app)) === 2, 'the session moved to a new window after Save All');
    const disk = readFileSync(join(d.root, 'a.ts'), 'utf8');
    assert(disk.startsWith('EDIT'), `disk has the edit: ${JSON.stringify(disk)}`);
    log('move ✓');
  },
});

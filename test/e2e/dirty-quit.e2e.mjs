/**
 * Dirty-editor quit guard: Save All / Don't Save / Cancel on quit
 * (docs/specs/2026-09-28-dirty-quit-guard.md). `DIRTY_QUIT_PHASE=<phase>` runs one phase.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirty, waitFor } from './auto-save-helpers.mjs';
import {
  assert,
  clickDialog,
  dirtyDialog,
  launchDirty,
  ORIGINAL,
  runPhases,
  sessionStatus,
  sleep,
  waitExit,
} from './dirty-quit-helpers.mjs';
import { openSession } from './harness.mjs';

const closeLastWindow = (app) =>
  app.evaluate((electron) => electron.BrowserWindow.getAllWindows()[0]?.close());

await runPhases('dirty-quit', {
  async saveAll({ log, track }) {
    const d = await launchDirty();
    track(d.launched);
    await closeLastWindow(d.app);
    const dialog = await dirtyDialog(d.page);
    const title = await dialog.locator('.confirm__title').textContent();
    assert(
      title === 'Do you want to save the changes you made to a.ts?',
      `unexpected dialog title: ${title}`,
    );
    assert(
      (await dialog.locator('.confirm__file', { hasText: 'a.ts' }).count()) === 1,
      'a.ts is listed',
    );
    const text = await dialog.textContent();
    assert(/will also stop \d+ running agent/.test(text), `running line present: ${text}`);
    assert((await sessionStatus(d.page, d.sid)) === 'running', 'session still running (A1)');
    await clickDialog(d.page, 'Save All');
    assert(await waitExit(d.app, 10000), 'app exits after Save All');
    const disk = readFileSync(join(d.root, 'a.ts'), 'utf8');
    assert(disk.startsWith('EDIT'), `disk has the edit: ${JSON.stringify(disk)}`);
    log('saveAll ✓');
  },

  async dontSave({ log, track }) {
    const d = await launchDirty();
    track(d.launched);
    await closeLastWindow(d.app);
    await dirtyDialog(d.page);
    await clickDialog(d.page, "Don't Save");
    assert(await waitExit(d.app, 10000), "app exits after Don't Save");
    // The beforeunload backstop must skip a discarded window (B3): give a stray save time to land.
    await sleep(500);
    const disk = readFileSync(join(d.root, 'a.ts'), 'utf8');
    assert(disk === ORIGINAL, `disk unchanged after Don't Save: ${JSON.stringify(disk)}`);
    log('dontSave ✓');
  },

  async cancel({ log, track }) {
    const d = await launchDirty();
    track(d.launched);
    await d.app.evaluate(({ app }) => app.quit());
    await dirtyDialog(d.page);
    await clickDialog(d.page, 'Cancel');
    await sleep(800);
    assert(
      (await d.app.evaluate((e) => e.BrowserWindow.getAllWindows().length)) === 1,
      'window stays open after Cancel',
    );
    assert((await sessionStatus(d.page, d.sid)) === 'running', 'session still running');
    assert(await isDirty(d.page, 'a.ts'), 'a.ts still dirty');
    const exitedWarn = await d.page
      .locator('[role="alertdialog"]', { hasText: 'Terminal exited' })
      .count();
    assert(exitedWarn === 0, 'no "Terminal exited" dialog after a cancelled quit (C3)');
    // The cancelled quit must not leave persistence frozen (A4/I1): a new session reaches disk.
    const userData = await d.app.evaluate(({ app }) => app.getPath('userData'));
    await openSession(d.page, { path: d.root });
    const sessionsFile = join(userData, 'sessions.json');
    const persisted = () => {
      if (!existsSync(sessionsFile)) return 0;
      try {
        const blob = JSON.parse(readFileSync(sessionsFile, 'utf8'));
        const list = Array.isArray(blob) ? blob : (blob.sessions ?? []);
        return list.length;
      } catch {
        return 0;
      }
    };
    const want = await d.page.evaluate(() => (window.__sessions || []).length);
    await waitFor(async () => persisted() >= want, `sessions.json lists ${want} sessions`, 5000);
    log('cancel ✓');
  },
});

/**
 * Dirty-editor quit guard: auto-save clears the way, a failed save keeps the dialog, a conflict is
 * force-written only from its tagged row (docs/specs/2026-09-28-dirty-quit-guard.md).
 * `DIRTY_QUIT_PHASE=<phase>` runs one phase.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assert,
  clickDialog,
  dirtyDialog,
  launchDirty,
  runPhases,
  sleep,
  waitExit,
  windowCount,
} from './dirty-quit-helpers.mjs';

const quit = (app) => app.evaluate(({ app: a }) => a.quit());
const disk = (root) => readFileSync(join(root, 'a.ts'), 'utf8');

await runPhases('dirty-quit-saves', {
  async autoSave({ log, track }) {
    const d = await launchDirty({ autoSave: 'afterDelay', autoSaveDelay: 1000 });
    track(d.launched);
    await quit(d.app);
    const dialog = d.page.locator('[role="alertdialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    assert(
      (await d.page.locator('.confirm--files').count()) === 0,
      'only the session dialog shows once the flush saved the file (A6)',
    );
    await clickDialog(d.page, 'Quit');
    assert(await waitExit(d.app, 10000), 'app exits after Quit');
    assert(disk(d.root).startsWith('EDIT'), `disk has the edit: ${JSON.stringify(disk(d.root))}`);
    log('autoSave ✓');
  },

  async failure({ log, track }) {
    const d = await launchDirty();
    track(d.launched);
    await d.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('writeFile');
      ipcMain.handle('writeFile', () => ({ ok: false, error: 'EACCES' }));
    });
    await quit(d.app);
    const dialog = await dirtyDialog(d.page);
    await clickDialog(d.page, 'Save All');
    await dialog
      .locator('.confirm__file', { hasText: 'save failed' })
      .waitFor({ state: 'visible', timeout: 5000 });
    await sleep(3000);
    assert((await windowCount(d.app)) === 1, 'app alive 3 s after a failed Save All (A7)');
    assert(await dialog.isVisible(), 'the dialog stays after a failed save');
    await clickDialog(d.page, "Don't Save");
    assert(await waitExit(d.app, 10000), "app exits after Don't Save");
    log('failure ✓');
  },

  async conflict({ log, track }) {
    const d = await launchDirty({ autoSave: 'afterDelay', autoSaveDelay: 1000 });
    track(d.launched);
    writeFileSync(join(d.root, 'a.ts'), 'changed on disk\n');
    // Let the auto-save fire against the changed file and land in conflict.
    await sleep(2500);
    await quit(d.app);
    const dialog = await dirtyDialog(d.page);
    await dialog
      .locator('.confirm__file', { hasText: 'changed on disk — Save All overwrites it' })
      .waitFor({ state: 'visible', timeout: 5000 });
    await clickDialog(d.page, 'Save All');
    assert(await waitExit(d.app, 10000), 'app exits after Save All over a conflict');
    assert(
      disk(d.root).startsWith('EDIT'),
      `disk holds the buffer: ${JSON.stringify(disk(d.root))}`,
    );
    log('conflict ✓');
  },
});

/**
 * settings-quit-flush — a settings edit still inside the renderer's persist debounce survives a
 * quit. It used to reach the host only from `pagehide`, racing the teardown: on some runners the
 * edit never reached settings.json and nav-keybindings-settings' relaunch step read the default.
 * The debounce is frozen and any updateSettings arriving once the window is closing is dropped,
 * so only the flush on the quit ask (webview/quit-responder.ts) can save it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, closeApp, runScenario } from './harness.mjs';

const DEF = 'Go to Definition';

runScenario('settings-quit-flush', async ({ app, page, log }) => {
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const onDisk = () => {
    try {
      return JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).settings.shortcuts;
    } catch {
      return null;
    }
  };

  await page.evaluate(() => {
    const orig = window.setTimeout;
    window.setTimeout = (fn, ms, ...a) => orig(fn, ms === 250 ? 600_000 : ms, ...a);
  });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    let closing = false;
    for (const w of BrowserWindow.getAllWindows()) w.on('close', () => (closing = true));
    const listeners = ipcMain.listeners('to-host');
    ipcMain.removeAllListeners('to-host');
    ipcMain.on('to-host', (e, m) => {
      if (closing && m?.type === 'updateSettings') return;
      for (const l of listeners) l(e, m);
    });
  });

  await page.locator('.footbtn[title^="Settings"]').click();
  await page.locator('.settings__navitem', { hasText: 'Shortcuts' }).click();
  await page.getByRole('button', { name: `Record shortcut for ${DEF}`, exact: true }).click();
  await page.keyboard.press('Alt+D');
  await page
    .locator('.shortcuts__row', {
      has: page.locator('.shortcuts__desc', { hasText: new RegExp(`^${DEF}`) }),
    })
    .locator('.shortcuts__keys kbd', { hasText: 'Alt + D' })
    .waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  assert(
    !onDisk()?.goToDefinition,
    `the edit must still be pending, on disk ${JSON.stringify(onDisk())}`,
  );

  await closeApp(app, page);
  assert(
    onDisk()?.goToDefinition === 'Alt+D',
    `the pending edit must be on disk after quit, got ${JSON.stringify(onDisk())}`,
  );
  log('a debounced settings edit is saved by the quit ask ✓');
});

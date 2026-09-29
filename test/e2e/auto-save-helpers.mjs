/**
 * Shared driver for the auto-save scenarios (auto-save-basics, auto-save): one app and one
 * project per scenario, phases that each own their files, and the mode switched over the real
 * `updateSettings` channel. `AUTO_SAVE_PHASE=<name>` runs one phase (inner loop);
 * `AUTO_SAVE_SHOTS=<absolute dir>` saves screenshots of the new UI there (runtime proof).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assert, launchApp, makeLog, openSession, shutdownApp } from './harness.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ONLY = process.env.AUTO_SAVE_PHASE;

export const shotter = (page) => async (name) => {
  if (process.env.AUTO_SAVE_SHOTS) {
    await page.screenshot({ path: join(process.env.AUTO_SAVE_SHOTS, `${name}.png`) });
  }
};

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const tab = (page, name) =>
  page
    .locator('.tabbar [role="tab"]', {
      has: page.locator('span', { hasText: new RegExp(`^${esc(name)}$`) }),
    })
    .first();
export const disk = (root, name) => readFileSync(join(root, name), 'utf8');

export async function waitFor(pred, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(50);
  }
  assert(false, `timed out waiting for ${what}`);
}

export async function openFile(page, name) {
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().dblclick();
  await page.waitForFunction(
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    { timeout: 15000 },
  );
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
}

export async function activate(page, name) {
  await tab(page, name).click();
  await page.waitForFunction(
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    { timeout: 10000 },
  );
}

export async function typeAtStart(page, text) {
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(text);
}

export const isDirty = (page, name) =>
  tab(page, name).evaluate((el) => el.classList.contains('tab--dirty'));

export async function closeTab(page, name, choice) {
  await tab(page, name).click({ button: 'middle' });
  if (choice) {
    await page.waitForSelector('.confirm[role="alertdialog"]', { timeout: 5000 });
    await page.locator('.confirm__actions button', { hasText: choice }).first().click();
  }
}

export async function paletteSaveAll(page) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { state: 'visible', timeout: 5000 });
  await page.keyboard.type('Save All');
  await page.locator('.palette', { hasText: 'Save All' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
}

export const modelValue = (page, name) =>
  page.evaluate(
    (n) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.toString().endsWith(`/${n}`))
        ?.getValue() ?? null,
    name,
  );

export async function waitForModel(page, name, value) {
  await page.waitForFunction(
    ({ n, v }) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.toString().endsWith(`/${n}`))
        ?.getValue() === v,
    { n: name, v: value },
    { timeout: 10000 },
  );
}

/** Switch the mode over the same `updateSettings` channel the Settings controls use, and wait
 *  for the host's broadcast of it — the renderer applies settings from that same message. */
export async function setMode(page, autoSave, autoSaveDelay = 1000) {
  await page.evaluate(
    ({ mode, delay }) =>
      new Promise((resolve) => {
        let sent = false;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          if (!sent) {
            sent = true;
            window.agentDeck.post({
              type: 'updateSettings',
              settings: { ...m.settings, autoSave: mode, autoSaveDelay: delay },
            });
          }
          if (m.settings?.autoSave === mode && m.settings?.autoSaveDelay === delay) {
            off();
            resolve();
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
    { mode: autoSave, delay: autoSaveDelay },
  );
  await sleep(50);
}

/**
 * Counts writes at the host: the real `writeFile` handler is wrapped by a pass-through, so every
 * renderer write (and the precondition it carried) is recorded without changing what it does.
 */
export async function spyWrites(app) {
  await app.evaluate(({ ipcMain }) => {
    if (global.__writeSpy) return;
    const real = ipcMain._invokeHandlers?.get('writeFile');
    if (!real) throw new Error('writeFile handler not reachable for the spy');
    global.__writeSpy = [];
    ipcMain.removeHandler('writeFile');
    ipcMain.handle('writeFile', (e, ...args) => {
      global.__writeSpy.push({ path: args[0], expected: args[2]?.expected ?? null });
      return real(e, ...args);
    });
  });
}
export const writesTo = async (app, name) =>
  (await app.evaluate(() => global.__writeSpy)).filter((w) =>
    w.path.replace(/\\/g, '/').endsWith(`/${name}`),
  );

/**
 * Run `before` (phases that bring their own app), then the editor phases in one app on one
 * project holding `files`. Exits the process with the harness convention (0/1/2).
 */
export async function runAutoSave(name, { before = {}, files, phases }) {
  const log = makeLog(name);
  if (process.platform !== 'win32') {
    log('SKIP — suite is Windows-only (non-win32 platform)');
    process.exit(0);
  }
  let code = 0;
  try {
    for (const [phase, run] of Object.entries(before)) {
      if (ONLY && ONLY !== phase) continue;
      log(`— phase ${phase}`);
      await run({ log });
    }
    const selected = Object.entries(phases).filter(([n]) => !ONLY || ONLY === n);
    if (selected.length > 0) {
      const root = mkdtempSync(join(tmpdir(), 'conduit-autosave-'));
      for (const [n, c] of Object.entries(files)) {
        mkdirSync(dirname(join(root, n)), { recursive: true });
        writeFileSync(join(root, n), c);
      }
      const launched = await launchApp();
      try {
        const { app, page } = launched;
        await openSession(page, { path: root });
        await spyWrites(app);
        await page.click('.rtab:has-text("Files")');
        await page.waitForSelector('.filerow__name', { timeout: 20000 });
        for (const [phase, run] of selected) {
          log(`— phase ${phase}`);
          await run({ app, page, root, log, shot: shotter(page) });
        }
      } finally {
        await shutdownApp(launched.app, launched.page).catch(() => {});
      }
    }
    log('PASS ✓');
  } catch (e) {
    code = e?.name === 'AssertionError' ? 1 : 2;
    console.error(`[${name}] ${code === 1 ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
    if (code === 2 && e?.stack) console.error(e.stack);
  }
  process.exit(code);
}

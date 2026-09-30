/**
 * Shared driver for the dirty-quit scenarios (dirty-quit, dirty-quit-saves, dirty-quit-windows,
 * dirty-session-close). `DIRTY_QUIT_PHASE=<name>` runs one phase (inner loop); each phase owns
 * its own app and temp root.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openFile, setMode, sleep, typeAtStart } from './auto-save-helpers.mjs';
import { assert, launchApp, makeLog, openSession, shutdownApp } from './harness.mjs';

export const ONLY = process.env.DIRTY_QUIT_PHASE;
export const ORIGINAL = 'export const a = 1;\n';

export function makeRoot(files = { 'a.ts': ORIGINAL }) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-dirtyquit-'));
  for (const [n, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, n)), { recursive: true });
    writeFileSync(join(root, n), c);
  }
  return root;
}

/** Open the Files tab of the active session and dirty `name` by typing `text` at its start. */
export async function dirtyFile(page, name = 'a.ts', text = 'EDIT') {
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  await openFile(page, name);
  await typeAtStart(page, text);
}

/**
 * Launch hidden, open a `shell:cmd` session on a temp root holding `files`, open `a.ts` and type
 * `EDIT` at its start. `autoSave` defaults to the shipped default (`off`).
 */
export async function launchDirty({ autoSave, autoSaveDelay, files, userDataDir } = {}) {
  const root = makeRoot(files);
  const launched = await launchApp(userDataDir ? { userDataDir } : {});
  const { app, page } = launched;
  const sid = await openSession(page, { path: root });
  if (autoSave) await setMode(page, autoSave, autoSaveDelay);
  await dirtyFile(page);
  return { app, page, root, sid, launched };
}

export async function dirtyDialog(page, timeout = 8000) {
  const dialog = page.locator('.confirm.confirm--files');
  await dialog.waitFor({ state: 'visible', timeout });
  return dialog;
}

export async function clickDialog(page, label) {
  await page
    .locator('.confirm[role="alertdialog"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** Resolves true once every window is gone (the app exited), false after `ms`. */
export async function waitExit(app, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const n = await app
      .evaluate((electron) => electron.BrowserWindow.getAllWindows().length)
      .catch(() => 0);
    if (n === 0) return true;
    await sleep(150);
  }
  return false;
}

export const sessionStatus = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id)?.status ?? null, sid);

export const windowCount = (app) =>
  app.evaluate((electron) => electron.BrowserWindow.getAllWindows().length).catch(() => 0);

/** Run each selected phase in turn with the harness exit convention (0 pass / 1 fail / 2 error). */
export async function runPhases(name, phases) {
  const log = makeLog(name);
  if (process.platform !== 'win32') {
    log('SKIP — suite is Windows-only (non-win32 platform)');
    process.exit(0);
  }
  let code = 0;
  const open = [];
  try {
    for (const [phase, run] of Object.entries(phases)) {
      if (ONLY && ONLY !== phase) continue;
      log(`— phase ${phase}`);
      await run({ log, track: (launched) => open.push(launched) });
      for (const l of open.splice(0)) await shutdownApp(l.app, l.page).catch(() => {});
    }
    log('PASS ✓');
  } catch (e) {
    code = e?.name === 'AssertionError' ? 1 : 2;
    console.error(`[${name}] ${code === 1 ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
    if (code === 2 && e?.stack) console.error(e.stack);
  } finally {
    for (const l of open) await shutdownApp(l.app, l.page).catch(() => {});
  }
  process.exit(code);
}

export { assert, sleep };

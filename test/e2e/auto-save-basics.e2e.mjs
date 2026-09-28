/**
 * Auto-save basics (docs/specs/2026-09-28-auto-save.md §7) against the real built app: the
 * setting and its persistence, `off` behaving as before, and background tabs being saveable or
 * released. The mode-driven saves and conflicts are in auto-save.e2e.mjs.
 *
 * Run after a fresh build: `npm run build` then `node test/e2e/run-smoke.mjs auto-save`.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activate,
  closeTab,
  disk,
  isDirty,
  openFile,
  paletteSaveAll,
  runAutoSave,
  setMode,
  shotter,
  sleep,
  tab,
  typeAtStart,
  waitFor,
  writesTo,
} from './auto-save-helpers.mjs';
import { assert, closeApp, launchApp, openSession, shutdownApp } from './harness.mjs';

async function openAppearance(page) {
  await page.click('.footbtn[title^="Settings"]');
  await page.locator('.settings__navitem', { hasText: 'Appearance' }).first().click();
  await page.locator('.selectfield[aria-label="Auto save"]').waitFor({ timeout: 8000 });
}

const persistedDelay = (udd) => {
  const f = join(udd, 'settings.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).settings?.autoSaveDelay : undefined;
};

async function phaseSettings({ log }) {
  const udd = mkdtempSync(join(tmpdir(), 'conduit-ud-autosave-'));
  let launched = await launchApp({ userDataDir: udd });
  try {
    let { page } = launched;
    await openAppearance(page);
    const select = page.locator('.selectfield[aria-label="Auto save"]');
    assert((await select.textContent())?.trim() === 'Off', 'Auto save starts at "Off"');
    assert(
      (await page.locator('.settings input[type="number"]').count()) === 0,
      'no delay field while Off',
    );

    await select.click();
    await page.locator('.ctxmenu__item', { hasText: 'After delay' }).click();
    const input = page.locator('.settings input[type="number"]');
    await input.waitFor({ timeout: 5000 });
    await shotter(page)('settings-auto-save');
    await input.fill('50');
    const err = page.locator('.set__field-error');
    await err.waitFor({ timeout: 3000 });
    assert((await err.textContent()) === 'Enter 100–60000 ms', 'inline error for 50');
    assert((await input.getAttribute('aria-invalid')) === 'true', 'aria-invalid on 50');
    await sleep(500);
    const d = persistedDelay(udd);
    assert(d === undefined || d === 1000, `an invalid draft never persists (got ${d})`);
    log('delay field: 50 → inline error, nothing persisted ✓');

    await input.fill('2000');
    await input.press('Enter');
    await waitFor(() => persistedDelay(udd) === 2000, 'Enter on 2000 to persist it');

    await input.fill('7');
    await input.press('Escape');
    assert((await input.inputValue()) === '2000', 'the first Esc reverts the draft');
    assert((await page.locator('.modal.settings').count()) === 1, 'the first Esc keeps Settings');
    await input.press('Escape');
    await page.locator('.modal.settings').waitFor({ state: 'detached', timeout: 5000 });
    log('delay field: first Esc reverts the draft, second closes Settings ✓');

    await closeApp(launched.app, page);
    launched = await launchApp({ userDataDir: udd });
    page = launched.page;
    await openAppearance(page);
    assert(
      (await page.locator('.selectfield[aria-label="Auto save"]').textContent())?.trim() ===
        'After delay',
      'mode survives a relaunch',
    );
    assert(
      (await page.locator('.settings input[type="number"]').inputValue()) === '2000',
      'delay survives a relaunch',
    );
    log('settings persist and the delay field is conditional ✓');
  } finally {
    await shutdownApp(launched.app, launched.page).catch(() => {});
  }
}

async function phaseOffManual({ page, root, log }) {
  await setMode(page, 'off');
  await openFile(page, 'off1.ts');
  await typeAtStart(page, 'x');
  await sleep(1500);
  assert(disk(root, 'off1.ts') === 'one\n', 'off: nothing is written without Ctrl+S');
  assert(await isDirty(page, 'off1.ts'), 'off: the tab stays dirty');
  await page.keyboard.press('Control+S');
  await waitFor(() => disk(root, 'off1.ts') === 'xone\n', 'Ctrl+S to write');
  await waitFor(async () => !(await isDirty(page, 'off1.ts')), 'the dot to clear');
  await closeTab(page, 'off1.ts');
  log('off: Ctrl+S writes and no automatic write happens ✓');
}

async function phaseOffSaveAll({ page, root, log }) {
  await setMode(page, 'off');
  await openFile(page, 'off2.ts');
  await openFile(page, 'off3.ts');
  await activate(page, 'off2.ts');
  await typeAtStart(page, 'y');
  await waitFor(() => isDirty(page, 'off2.ts'), 'off2 dirty');
  await activate(page, 'off3.ts');
  await paletteSaveAll(page);
  await waitFor(() => disk(root, 'off2.ts') === 'yone\n', 'Save All to write the background tab');
  await waitFor(async () => !(await isDirty(page, 'off2.ts')), 'the background dot to clear');
  log('off: Save All saves a dirty background tab ✓');

  await activate(page, 'off2.ts');
  await typeAtStart(page, 'z');
  await waitFor(() => isDirty(page, 'off2.ts'), 'off2 dirty again');
  await activate(page, 'off3.ts');
  await closeTab(page, 'off2.ts', 'Save');
  await waitFor(async () => (await tab(page, 'off2.ts').count()) === 0, 'the tab to close');
  assert(disk(root, 'off2.ts') === 'zyone\n', 'close→Save wrote the background tab');
  log('off: close-dirty prompts, and Save on a background tab saves and closes ✓');
  await closeTab(page, 'off3.ts');
}

async function phaseSessionClose({ app, page, log }) {
  await setMode(page, 'off');
  const other = mkdtempSync(join(tmpdir(), 'conduit-autosave-other-'));
  writeFileSync(join(other, 'gone.ts'), 'one\n');
  const sid = await openSession(page, { path: other });
  await page.click('.rtab:has-text("Files")');
  await openFile(page, 'gone.ts');
  await typeAtStart(page, 'orphan');
  await waitFor(() => isDirty(page, 'gone.ts'), 'gone.ts dirty');
  await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
  await waitFor(async () => (await tab(page, 'gone.ts').count()) === 0, 'the session tab to go');
  // The killed session took focus with it; give the window a focused element for the palette.
  await page.click('.rtab:has-text("Files")');
  await paletteSaveAll(page);
  await sleep(800);
  assert(disk(other, 'gone.ts') === 'one\n', "Save All must not write a closed session's buffer");
  assert((await writesTo(app, 'gone.ts')).length === 0, 'no write was even attempted');
  log("closing a session releases its tabs' unsaved buffers ✓");
}

runAutoSave('auto-save-basics', {
  before: { settings: phaseSettings },
  files: { 'off1.ts': 'one\n', 'off2.ts': 'one\n', 'off3.ts': 'one\n' },
  phases: {
    offManual: phaseOffManual,
    offSaveAll: phaseOffSaveAll,
    sessionClose: phaseSessionClose,
  },
});

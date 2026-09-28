/**
 * Auto-save (docs/specs/2026-09-28-auto-save.md §7) against the real built app. Disk is asserted
 * with fs in this process; keystrokes are real keyboard input into Monaco.
 *
 * Phases share as few launches as the 210 s runner budget needs: one pair for settings
 * persistence, then one app whose mode is switched over the real `updateSettings` channel.
 * `AUTO_SAVE_PHASE=<name>` runs one phase (inner loop).
 *
 * needs-human-smoke: "onWindowChange saves on window blur" (E5). `win.blur()` on the hidden
 * harness window never reaches the renderer as a `blur` (plan run notes M12), and a synthetic
 * `window.dispatchEvent(new Event('blur'))` would pass against a build no user can trigger.
 *
 * Run after a fresh build: `npm run build` then `node test/e2e/run-smoke.mjs auto-save`.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession, shutdownApp } from './harness.mjs';

const NAME = 'auto-save';
const log = makeLog(NAME);
const ONLY = process.env.AUTO_SAVE_PHASE;

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openAppearance(page) {
  await page.click('.footbtn[title^="Settings"]');
  await page.locator('.settings__navitem', { hasText: 'Appearance' }).first().click();
  await page.locator('.selectfield[aria-label="Auto save"]').waitFor({ timeout: 8000 });
}

const persistedDelay = (udd) => {
  const f = join(udd, 'settings.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).settings?.autoSaveDelay : undefined;
};

async function phaseSettings() {
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
    await input.fill('50');
    const err = page.locator('.set__field-error');
    await err.waitFor({ timeout: 3000 });
    assert((await err.textContent()) === 'Enter 100–60000 ms', 'inline error for 50');
    assert((await input.getAttribute('aria-invalid')) === 'true', 'aria-invalid on 50');
    await sleep(1000);
    const d = persistedDelay(udd);
    assert(d === undefined || d === 1000, `an invalid draft never persists (got ${d})`);
    log('delay field: 50 → inline error, nothing persisted ✓');

    await input.fill('2000');
    await input.press('Enter');
    const deadline = Date.now() + 5000;
    while (persistedDelay(udd) !== 2000 && Date.now() < deadline) await sleep(100);
    assert(persistedDelay(udd) === 2000, 'Enter on 2000 persists it');

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

// ── Editor phases: one app, one project; each phase owns its own files. ────────────────────────

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tab = (page, name) =>
  page
    .locator('.tabbar [role="tab"]', {
      has: page.locator('span', { hasText: new RegExp(`^${esc(name)}$`) }),
    })
    .first();
const disk = (root, name) => readFileSync(join(root, name), 'utf8');

async function waitFor(pred, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(50);
  }
  assert(false, `timed out waiting for ${what}`);
}

async function openFile(page, name) {
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

async function activate(page, name) {
  await tab(page, name).click();
  await page.waitForFunction(
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    { timeout: 10000 },
  );
}

async function typeAtStart(page, text) {
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(text);
}

const isDirty = (page, name) =>
  tab(page, name).evaluate((el) => el.classList.contains('tab--dirty'));

async function closeTab(page, name, choice) {
  await tab(page, name).click({ button: 'middle' });
  if (choice) {
    await page.waitForSelector('.confirm[role="alertdialog"]', { timeout: 5000 });
    await page.locator('.confirm__actions button', { hasText: choice }).first().click();
  }
}

async function paletteSaveAll(page) {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { state: 'visible', timeout: 5000 });
  await page.keyboard.type('Save All');
  await sleep(150);
  await page.keyboard.press('Enter');
}

/** Switch the mode over the same `updateSettings` channel the Settings controls use. */
async function setMode(page, autoSave, autoSaveDelay = 1000) {
  await page.evaluate(
    ({ mode, delay }) =>
      new Promise((resolve) => {
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          off();
          window.agentDeck.post({
            type: 'updateSettings',
            settings: { ...m.settings, autoSave: mode, autoSaveDelay: delay },
          });
          resolve();
        });
        window.agentDeck.post({ type: 'ready' });
      }),
    { mode: autoSave, delay: autoSaveDelay },
  );
  await sleep(300);
}

async function phaseOffManual({ page, root }) {
  await setMode(page, 'off');
  await openFile(page, 'off1.ts');
  await typeAtStart(page, 'x');
  await sleep(2000);
  assert(disk(root, 'off1.ts') === 'one\n', 'off: nothing is written without Ctrl+S');
  assert(await isDirty(page, 'off1.ts'), 'off: the tab stays dirty');
  await page.keyboard.press('Control+S');
  await waitFor(() => disk(root, 'off1.ts') === 'xone\n', 'Ctrl+S to write');
  await waitFor(async () => !(await isDirty(page, 'off1.ts')), 'the dot to clear');
  await closeTab(page, 'off1.ts');
  log('off: Ctrl+S writes and no automatic write happens ✓');
}

async function phaseOffSaveAll({ page, root }) {
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

const EDITOR_FILES = {
  'off1.ts': 'one\n',
  'off2.ts': 'one\n',
  'off3.ts': 'one\n',
};
const EDITOR_PHASES = { offManual: phaseOffManual, offSaveAll: phaseOffSaveAll };

async function runEditorPhases() {
  const phases = Object.entries(EDITOR_PHASES).filter(([n]) => !ONLY || ONLY === n);
  if (phases.length === 0) return;
  const root = mkdtempSync(join(tmpdir(), 'conduit-autosave-'));
  for (const [n, c] of Object.entries(EDITOR_FILES)) writeFileSync(join(root, n), c);
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await openSession(page, { path: root });
    await page.click('.rtab:has-text("Files")');
    await page.waitForSelector('.filerow__name', { timeout: 20000 });
    for (const [name, run] of phases) {
      log(`— phase ${name}`);
      await run({ app, page, root });
    }
  } finally {
    await shutdownApp(launched.app, launched.page).catch(() => {});
  }
}

let code = 0;
try {
  if (!ONLY || ONLY === 'settings') {
    log('— phase settings');
    await phaseSettings();
  }
  await runEditorPhases();
  log('PASS ✓');
} catch (e) {
  code = e?.name === 'AssertionError' ? 1 : 2;
  console.error(`[${NAME}] ${code === 1 ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  if (code === 2 && e?.stack) console.error(e.stack);
}
process.exit(code);

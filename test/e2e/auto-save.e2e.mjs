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

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
/** `AUTO_SAVE_SHOTS=<absolute dir>` saves screenshots of the new UI there (runtime proof). */
const shotter = (page) => async (name) => {
  if (process.env.AUTO_SAVE_SHOTS) {
    await page.screenshot({ path: join(process.env.AUTO_SAVE_SHOTS, `${name}.png`) });
  }
};

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
    await shotter(page)('settings-auto-save');
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

/**
 * Counts writes at the host: the real `writeFile` handler is wrapped by a pass-through, so every
 * renderer write (and the precondition it carried) is recorded without changing what it does.
 */
async function spyWrites(app) {
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
const writesTo = async (app, name) =>
  (await app.evaluate(() => global.__writeSpy)).filter((w) =>
    w.path.replace(/\\/g, '/').endsWith(`/${name}`),
  );

async function phaseAfterDelay({ app, page, root }) {
  await setMode(page, 'afterDelay', 500);
  await openFile(page, 'ad.ts');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  for (const ch of 'abc') {
    await page.keyboard.type(ch);
    await sleep(100);
  }
  await waitFor(() => disk(root, 'ad.ts') === 'abcone\n', 'the auto-save after the pause', 1500);
  const writes = await writesTo(app, 'ad.ts');
  assert(writes.length === 1, `one write for the burst, got ${writes.length}`);
  assert(writes[0].expected === 'one\n', 'the auto-save carried the on-disk precondition');
  await waitFor(async () => !(await isDirty(page, 'ad.ts')), 'the dot to clear');
  // An auto-save recreates the editor (C8); the next keystroke must still land in it.
  await page.keyboard.type('d');
  await waitFor(() => disk(root, 'ad.ts') === 'abcdone\n', 'typing to continue after a save');
  await closeTab(page, 'ad.ts');
  log('afterDelay writes after a pause and coalesces a burst ✓');
}

async function phaseFocusTabSwitch({ page, root }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'fc1.ts');
  await openFile(page, 'fc2.ts');
  await activate(page, 'fc1.ts');
  await typeAtStart(page, 'x');
  await activate(page, 'fc2.ts');
  await waitFor(() => disk(root, 'fc1.ts') === 'xone\n', 'the tab switch to save fc1');
  await waitFor(
    async () => (await page.locator('.tabbar .tab--dirty').count()) === 0,
    'no tab to show an unsaved dot',
  );
  await closeTab(page, 'fc1.ts');
  await closeTab(page, 'fc2.ts');
  log('onFocusChange saves on tab switch ✓');
}

async function phaseCleanNeverReverts({ page, root }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'cl1.ts');
  await openFile(page, 'cl2.ts');
  await activate(page, 'cl1.ts');
  writeFileSync(join(root, 'cl1.ts'), 'theirs\n');
  await page.waitForFunction(
    () =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.toString().endsWith('/cl1.ts'))
        ?.getValue() === 'theirs\n',
    null,
    { timeout: 10000 },
  );
  await activate(page, 'cl2.ts');
  await sleep(1000);
  assert(disk(root, 'cl1.ts') === 'theirs\n', "a clean tab must not revert an agent's change");
  await closeTab(page, 'cl1.ts');
  await closeTab(page, 'cl2.ts');
  log("a clean open tab never reverts an agent's change ✓");
}

async function phaseCloseNoPrompt({ page, root }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'q.ts');
  await typeAtStart(page, 'q');
  await page.keyboard.press('Control+W');
  await waitFor(async () => (await tab(page, 'q.ts').count()) === 0, 'the dirty tab to close');
  assert(
    (await page.locator('.confirm[role="alertdialog"]').count()) === 0,
    'no dialog while closing a dirty tab with auto-save on',
  );
  assert(disk(root, 'q.ts') === 'qone\n', 'the close saved the edit');
  log("closing a dirty tab with auto-save on doesn't prompt ✓");
}

async function phaseWindowChange() {
  log(
    'onWindowChange saves on window blur — needs-human-smoke (M12: no renderer blur when hidden)',
  );
}

const modelValue = (page, name) =>
  page.evaluate(
    (n) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.toString().endsWith(`/${n}`))
        ?.getValue() ?? null,
    name,
  );
const banner = (page) => page.locator('.viewer__banner--warn');

async function phaseExternalChange({ app, page, root, shot }) {
  await setMode(page, 'afterDelay', 500);
  await openFile(page, 'ex.ts');
  await typeAtStart(page, 'mine');
  writeFileSync(join(root, 'ex.ts'), 'theirs\n');
  await sleep(1500);
  assert(disk(root, 'ex.ts') === 'theirs\n', 'the external change was not clobbered');
  await banner(page).waitFor({ timeout: 5000 });
  const text = await banner(page).textContent();
  assert(text?.includes('ex.ts changed on disk'), `banner names the file, got "${text}"`);
  assert(text?.includes('Overwrite') && text.includes('Reload from disk'), 'banner actions');
  assert(
    (await page
      .locator('.tab__conflict[aria-label="Changed on disk — auto-save paused"]')
      .count()) === 1,
    'the tab shows the conflict marker',
  );
  await shot?.('conflict-banner');
  await sleep(1000);
  assert(
    (await writesTo(app, 'ex.ts')).length === 1,
    'auto-save is paused: no further write while in conflict',
  );
  await banner(page).locator('button', { hasText: 'Overwrite' }).click();
  await waitFor(() => disk(root, 'ex.ts') === 'mineone\n', 'Overwrite to write the buffer');
  await waitFor(async () => !(await isDirty(page, 'ex.ts')), 'the dot to clear after Overwrite');
  log('an external change is never clobbered; Overwrite writes the buffer ✓');

  await typeAtStart(page, 'more');
  writeFileSync(join(root, 'ex.ts'), 'theirs2\n');
  await banner(page).waitFor({ timeout: 5000 });
  await banner(page).locator('button', { hasText: 'Reload from disk' }).click();
  await page.waitForFunction(
    () =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.toString().endsWith('/ex.ts'))
        ?.getValue() === 'theirs2\n',
    null,
    { timeout: 10000 },
  );
  await waitFor(async () => !(await isDirty(page, 'ex.ts')), 'no dot after Reload');
  assert((await banner(page).count()) === 0, 'the banner goes away after Reload');
  assert(disk(root, 'ex.ts') === 'theirs2\n', 'Reload wrote nothing');
  await closeTab(page, 'ex.ts');
  log('Reload from disk adopts the disk content ✓');
}

async function phaseFailedSave({ page, root }) {
  const file = join(root, 'ro.ts');
  await setMode(page, 'afterDelay', 300);
  await openFile(page, 'ro.ts');
  const toasts0 = await page.locator('.toast--error').count();
  chmodSync(file, 0o444);
  try {
    await typeAtStart(page, 'z');
    await sleep(1500);
    assert(await isDirty(page, 'ro.ts'), 'a failed save keeps the unsaved dot');
    await page.locator('.viewer__banner--error').waitFor({ timeout: 3000 });
    await page.keyboard.type('z');
    await sleep(1500);
    const toasts = (await page.locator('.toast--error').count()) - toasts0;
    assert(toasts === 1, `exactly one error toast for the failure streak, got ${toasts}`);
    assert((await modelValue(page, 'ro.ts')) === 'zzone\n', 'the buffer is kept');
    assert(disk(root, 'ro.ts') === 'one\n', 'nothing reached disk');
    // Still read-only, so the close's own save fails too and falls back to the prompt.
    await closeTab(page, 'ro.ts', 'Discard');
  } finally {
    chmodSync(file, 0o644);
  }
  log('failed save keeps the buffer and does not storm ✓');
}

async function phaseConflictedBackground({ app, page, root }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'cb1.ts');
  await openFile(page, 'cb2.ts');
  await activate(page, 'cb1.ts');
  await typeAtStart(page, 'mine');
  writeFileSync(join(root, 'cb1.ts'), 'theirs\n');
  await sleep(500);
  await activate(page, 'cb2.ts');
  await page
    .locator('.tab__conflict[aria-label="Changed on disk — auto-save paused"]')
    .waitFor({ timeout: 5000 });
  assert(disk(root, 'cb1.ts') === 'theirs\n', 'the background conflict wrote nothing');
  const before = (await writesTo(app, 'cb1.ts')).length;
  await tab(page, 'cb1.ts').click({ button: 'middle' });
  await page.waitForSelector('.confirm[role="alertdialog"]', { timeout: 5000 });
  const msg = await page.locator('.confirm__msg').first().textContent();
  assert(
    msg?.startsWith("Couldn't save automatically: The file changed on disk."),
    `the prompt names the reason, got "${msg}"`,
  );
  await page.locator('.confirm__actions button', { hasText: 'Save' }).first().click();
  await sleep(800);
  assert((await tab(page, 'cb1.ts').count()) === 1, 'Save during a conflict leaves the tab open');
  assert(disk(root, 'cb1.ts') === 'theirs\n', 'Save during a conflict writes nothing');
  assert((await writesTo(app, 'cb1.ts')).length === before, 'no write was even attempted');
  assert((await modelValue(page, 'cb1.ts')) === 'mineone\n', 'the edits are kept');
  await closeTab(page, 'cb1.ts', 'Discard');
  await closeTab(page, 'cb2.ts');
  log('a conflicted background tab keeps its edits ✓');
}

const EDITOR_FILES = {
  'off1.ts': 'one\n',
  'off2.ts': 'one\n',
  'off3.ts': 'one\n',
  'ad.ts': 'one\n',
  'fc1.ts': 'one\n',
  'fc2.ts': 'one\n',
  'cl1.ts': 'one\n',
  'cl2.ts': 'one\n',
  'q.ts': 'one\n',
  'ex.ts': 'one\n',
  'ro.ts': 'one\n',
  'cb1.ts': 'one\n',
  'cb2.ts': 'one\n',
};
const EDITOR_PHASES = {
  offManual: phaseOffManual,
  offSaveAll: phaseOffSaveAll,
  afterDelay: phaseAfterDelay,
  focusTabSwitch: phaseFocusTabSwitch,
  cleanNeverReverts: phaseCleanNeverReverts,
  closeNoPrompt: phaseCloseNoPrompt,
  windowChange: phaseWindowChange,
  externalChange: phaseExternalChange,
  failedSave: phaseFailedSave,
  conflictedBackground: phaseConflictedBackground,
};

async function runEditorPhases() {
  const phases = Object.entries(EDITOR_PHASES).filter(([n]) => !ONLY || ONLY === n);
  if (phases.length === 0) return;
  const root = mkdtempSync(join(tmpdir(), 'conduit-autosave-'));
  for (const [n, c] of Object.entries(EDITOR_FILES)) writeFileSync(join(root, n), c);
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    await openSession(page, { path: root });
    await spyWrites(app);
    await page.click('.rtab:has-text("Files")');
    await page.waitForSelector('.filerow__name', { timeout: 20000 });
    for (const [name, run] of phases) {
      log(`— phase ${name}`);
      await run({ app, page, root, shot: shotter(page) });
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

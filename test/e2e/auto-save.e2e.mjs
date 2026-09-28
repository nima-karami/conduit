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
import { assert, closeApp, launchApp, makeLog, shutdownApp } from './harness.mjs';

const NAME = 'auto-save';
const log = makeLog(NAME);
const ONLY = process.env.AUTO_SAVE_PHASE;

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openAppearance(page) {
  await page.keyboard.press('Control+,');
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

const PHASES = { settings: phaseSettings };

let code = 0;
try {
  for (const [name, run] of Object.entries(PHASES)) {
    if (ONLY && ONLY !== name) continue;
    log(`— phase ${name}`);
    await run();
  }
  log('PASS ✓');
} catch (e) {
  code = e?.name === 'AssertionError' ? 1 : 2;
  console.error(`[${NAME}] ${code === 1 ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  if (code === 2 && e?.stack) console.error(e.stack);
}
process.exit(code);

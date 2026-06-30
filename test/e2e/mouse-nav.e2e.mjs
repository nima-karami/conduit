/**
 * VS Code-style mouse buttons (real-app smoke). Crosses the doc-tab / explorer /
 * nav-history seams the mock preview shell can't exercise:
 *   - middle-click (auxclick button 1) on a CLEAN doc tab closes it (existing close path)
 *   - middle-click a DIRTY tab raises the unsaved-changes confirm (stays open)
 *   - Alt+Left / Alt+Right traverse the existing nav history across opened docs
 *   - middle-click an explorer FILE row opens a permanent (non-preview) tab
 *
 * See docs/specs/2026-06-30-mouse-nav-buttons.md §7 (acceptance).
 *
 * Run after a fresh build: `npm run build` then `node test/e2e/run-smoke.mjs mouse-nav`.
 *
 * NOT covered here (needs-human-smoke — not deterministically simulable):
 *   - The PHYSICAL X1/X2 thumb buttons (Chromium delivers them inconsistently; synthetic
 *     button-3/4 events don't faithfully reproduce the OS path).
 *   - The Windows `app-command` (browser-backward/forward) host fallback — it originates
 *     from a real OS thumb-button press on a focused native window.
 * Both share the SAME renderer entry point as the tested paths (goBack/goForward via the
 * modal-guarded navBack/navForward), so this scenario exercises that logic; only the OS
 * input edge is left to a human.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

// Doc tabs are role="tab" inside the editor strip (.tabbar); the terminal/session tab is
// a <button> without that role. Scope to .tabbar so unrelated app-wide role="tab" elements
// (sidebar/right-pane tabs) aren't counted.
const tabInfo = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]')).map((el) => ({
      title: el.querySelector('span')?.textContent ?? '',
      preview: el.classList.contains('tab--preview'),
      active: el.classList.contains('tab--active'),
    })),
  );

const activeDocTitle = (page) =>
  page.evaluate(
    () => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent ?? null,
  );

runScenario('mouse-nav', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-mousenav-'));
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, f), `${f}\n`);
  const openedPath = root.replace(/\\/g, '/');

  await openSession(page, { path: openedPath });

  // Switch to the Files tab and wait for the tree rows to load.
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  const row = (name) => page.locator('.filerow', { hasText: name }).first();

  // Open a.txt and b.txt as permanent tabs, building nav history terminal → a → b.
  await row('a.txt').dblclick();
  await page.waitForFunction(
    () => {
      const t = document.querySelectorAll('.tabbar [role="tab"]');
      return t.length === 1 && t[0].querySelector('span')?.textContent === 'a.txt';
    },
    null,
    { timeout: 10000 },
  );
  await row('b.txt').dblclick();
  await page.waitForFunction(
    () => {
      const t = Array.from(document.querySelectorAll('.tabbar [role="tab"]'));
      return t.length === 2 && t.some((el) => el.querySelector('span')?.textContent === 'b.txt');
    },
    null,
    { timeout: 10000 },
  );
  assert((await activeDocTitle(page)) === 'b.txt', 'b.txt should be active after opening it');
  log('opened a.txt + b.txt as two permanent tabs ✓');

  // Alt+Left → back to a.txt.
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(
    () => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === 'a.txt',
    null,
    { timeout: 10000 },
  );
  log('Alt+Left → a.txt active (nav back) ✓');

  // Alt+Right → forward to b.txt.
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForFunction(
    () => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === 'b.txt',
    null,
    { timeout: 10000 },
  );
  log('Alt+Right → b.txt active (nav forward) ✓');

  // Middle-click an explorer FILE row → opens a permanent (non-preview) tab for c.txt.
  await row('c.txt').click({ button: 'middle' });
  await page.waitForFunction(
    () => {
      const c = Array.from(document.querySelectorAll('.tabbar [role="tab"]')).find(
        (el) => el.querySelector('span')?.textContent === 'c.txt',
      );
      return !!c && !c.classList.contains('tab--preview');
    },
    null,
    { timeout: 10000 },
  );
  log('middle-click explorer c.txt → permanent (non-italic) tab ✓');

  // Middle-click a CLEAN tab (c.txt) → it closes via the existing close path.
  await page
    .locator('.tabbar [role="tab"]', { hasText: 'c.txt' })
    .first()
    .click({ button: 'middle' });
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (el) => el.querySelector('span')?.textContent === 'c.txt',
      ),
    null,
    { timeout: 10000 },
  );
  let tabs = await tabInfo(page);
  assert(!tabs.some((t) => t.title === 'c.txt'), 'middle-clicking a clean tab should close it');
  log('middle-click clean tab → closed ✓');

  // Dirty a tab, then middle-click it → the unsaved-changes confirm appears (stays open).
  await page.locator('.tabbar [role="tab"]', { hasText: 'a.txt' }).first().click();
  await page.waitForSelector('.monaco-editor', { timeout: 10000 });
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.type('dirty');
  await page.waitForSelector('.tab--dirty', { timeout: 10000 });
  await page
    .locator('.tabbar [role="tab"]', { hasText: 'a.txt' })
    .first()
    .click({ button: 'middle' });
  await page.waitForSelector('.confirm[role="alertdialog"]', { timeout: 10000 });
  const confirmText = await page.locator('.confirm__title').first().textContent();
  assert(
    /Unsaved changes/i.test(confirmText ?? ''),
    `middle-click on a dirty tab should raise the unsaved-changes confirm, got "${confirmText}"`,
  );
  log('middle-click dirty tab → unsaved-changes confirm ✓');

  // Discard so the dirty buffer doesn't linger into teardown.
  await page.locator('.confirm__actions button', { hasText: 'Discard' }).first().click();

  await closeApp(app, page);
});

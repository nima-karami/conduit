/**
 * VS Code-style PREVIEW/PIN editor tabs for file docs (real-app smoke). Crosses the
 * explorer → doc-reducer → tab-strip seam that the mock preview shell can't exercise:
 * a single click must open ONE reusable italic preview tab, a second single click must
 * replace it in place (tab count stays 1), and a double-click must promote it to a
 * permanent (non-italic) tab so the next single-click opens a fresh preview beside it.
 *
 * See docs/specs/2026-06-27-editor-tab-behavior.md §6 (MVP) / §7 (acceptance).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

// Doc tabs are role="tab" inside the editor strip (.tabbar); the terminal/session tab is
// a <button> without that role. Scope to .tabbar so unrelated app-wide role="tab" elements
// (sidebar/right-pane tabs) aren't counted.
const tabInfo = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]')).map((el) => ({
      title: el.querySelector('span')?.textContent ?? '',
      preview: el.classList.contains('tab--preview'),
      label: el.getAttribute('aria-label') ?? '',
    })),
  );

runScenario('editor-preview-tabs', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-preview-'));
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, f), `${f}\n`);
  const openedPath = root.replace(/\\/g, '/');

  await openSession(page, { path: openedPath });

  // Switch to the Files tab and wait for the tree rows to load.
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  const row = (name) => page.locator('.filerow', { hasText: name }).first();

  // Single-click a.txt → exactly one italic preview tab.
  await row('a.txt').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.tabbar [role="tab"]').length === 1,
    null,
    {
      timeout: 10000,
    },
  );
  let tabs = await tabInfo(page);
  assert(tabs.length === 1, `expected 1 doc tab, got ${tabs.length}`);
  assert(tabs[0].title === 'a.txt', `expected a.txt, got "${tabs[0].title}"`);
  assert(tabs[0].preview, 'a.txt should be an italic preview tab');
  assert(
    /\(preview\)/.test(tabs[0].label),
    `preview tab should carry "(preview)" in its accessible name, got "${tabs[0].label}"`,
  );
  log('single-click a.txt → 1 italic preview tab (with ARIA cue) ✓');

  // Single-click b.txt → still ONE tab, now b.txt (replace-in-place, no growth).
  await row('b.txt').click();
  await page.waitForFunction(
    () => {
      const t = document.querySelectorAll('.tabbar [role="tab"]');
      return t.length === 1 && t[0].querySelector('span')?.textContent === 'b.txt';
    },
    null,
    { timeout: 10000 },
  );
  tabs = await tabInfo(page);
  assert(tabs.length === 1, `replace-in-place: expected 1 tab, got ${tabs.length}`);
  assert(tabs[0].title === 'b.txt' && tabs[0].preview, 'b.txt should be the single preview tab');
  log('single-click b.txt → still 1 tab, now b.txt (replace-in-place) ✓');

  // Double-click b.txt → promote to permanent (not italic).
  await row('b.txt').dblclick();
  await page.waitForFunction(
    () => {
      const t = document.querySelectorAll('.tabbar [role="tab"]');
      return t.length === 1 && !t[0].classList.contains('tab--preview');
    },
    null,
    { timeout: 10000 },
  );
  tabs = await tabInfo(page);
  assert(
    tabs.length === 1 && tabs[0].title === 'b.txt' && !tabs[0].preview,
    'double-click should make b.txt a permanent (non-italic) tab',
  );
  log('double-click b.txt → permanent (non-italic) ✓');

  // Single-click c.txt → 2 tabs: permanent b + preview c.
  await row('c.txt').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.tabbar [role="tab"]').length === 2,
    null,
    {
      timeout: 10000,
    },
  );
  tabs = await tabInfo(page);
  assert(tabs.length === 2, `expected 2 tabs, got ${tabs.length}`);
  const b = tabs.find((t) => t.title === 'b.txt');
  const c = tabs.find((t) => t.title === 'c.txt');
  assert(!!b && !b.preview, 'b.txt should remain a permanent tab');
  assert(!!c && c.preview, 'c.txt should be the new preview tab');
  log('single-click c.txt → permanent b.txt + preview c.txt ✓');
});

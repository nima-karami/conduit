/**
 * search-selection — Mod+Shift+F seeds global search from the current selection.
 *
 * VS Code / Cursor parity. The unit tests cover the classifier and the registry in isolation;
 * this proves the whole chain in the real app: a Monaco selection reaches the search box,
 * and a MULTI-LINE selection survives — which is the part that could not work before, because
 * the field was an <input> and HTML's value-sanitization strips newlines from `.value`.
 *
 * Windows-only, matching the suite.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[search-selection] SKIP — suite is Windows-only');
  process.exit(0);
}

const FIXTURE = [
  'const alpha = 1;',
  'const bravo = 2;',
  'const charlie = 3;',
  '',
  'export { alpha, bravo, charlie };',
].join('\n');

const queryValue = (page) =>
  page.evaluate(() => document.querySelector('.search__inputbox textarea')?.value ?? null);

runScenario('search-selection', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-seed-'));
  writeFileSync(join(root, 'source.ts'), FIXTURE);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  await page.locator('.filerow', { hasText: 'source.ts' }).first().click();
  await page.waitForSelector('.docpanel .monaco-editor', { timeout: 25000 });
  await page.waitForTimeout(2500);

  // ── Single-line selection ────────────────────────────────────────────────
  // Drive Monaco's own selection API rather than synthesising drags: the feature reads
  // editor.getSelection(), so that is the thing under test.
  await page.evaluate(() => {
    const ed = window.monaco?.editor?.getEditors?.()[0];
    ed?.setSelection({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 17 });
    ed?.focus();
  });
  await page.waitForTimeout(400);

  await page.keyboard.press('Control+Shift+F');
  await page.waitForSelector('.search__inputbox textarea', { timeout: 15000 });
  await page.waitForTimeout(900);

  const single = await queryValue(page);
  log(`seeded (single line): ${JSON.stringify(single)}`);
  assert(
    single === 'const bravo = 2;',
    `the search box must hold the selected line, got ${JSON.stringify(single)}`,
  );
  log('a Monaco selection seeds global search ✓');

  // ── Multi-line selection — the part that was impossible before ───────────
  await page.evaluate(() => {
    const ed = window.monaco?.editor?.getEditors?.()[0];
    ed?.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 17 });
    ed?.focus();
  });
  await page.waitForTimeout(400);

  await page.keyboard.press('Control+Shift+F');
  await page.waitForTimeout(900);

  const multi = await queryValue(page);
  log(`seeded (two lines): ${JSON.stringify(multi)}`);
  assert(
    multi?.includes('\n'),
    `a multi-line selection must reach the box WITH its newline — an <input> would have stripped it. Got ${JSON.stringify(multi)}`,
  );
  assert(
    multi === 'const alpha = 1;\nconst bravo = 2;',
    `both lines must survive intact, got ${JSON.stringify(multi)}`,
  );
  log('a multi-line selection survives into the query, newline intact ✓');

  // And the engine can actually match it — a result for a two-line query proves the
  // per-line scan was really bypassed, not just that the box accepted the text.
  await page.waitForTimeout(1200);
  const hits = await page.locator('.searchmatch').count();
  log(`results for the two-line query: ${hits}`);
  assert(hits > 0, 'a multi-line query must actually find its span in the file');
  log('the multi-line query matches across the line boundary ✓');

  log('PASS — selection seeds the search box, multi-line survives and matches');
});

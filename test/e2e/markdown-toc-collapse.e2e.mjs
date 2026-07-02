/**
 * Collapsible Markdown outline (spec: docs/specs — md-toc collapse follow-up).
 *
 * Drives the REAL app: opens CHANGELOG.md rendered, opens the Outline panel, and checks
 * that collapsing a parent heading hides its nested entries and expanding restores them.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, REPO, runScenario } from './harness.mjs';

runScenario('markdown-toc-collapse', async ({ app, page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^CHANGELOG\.md$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page
    .locator('.markdown h1, .markdown h2')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  log('CHANGELOG.md rendered ✓');

  await page.locator('.viewer__toggle', { hasText: 'Outline' }).click();
  await page.locator('.markdown-toc').waitFor({ state: 'visible', timeout: 5000 });
  const items = page.locator('.markdown-toc__item');
  const before = await items.count();
  assert(before >= 3, `outline should list several headings, got ${before}`);
  const toggles = page.locator('.markdown-toc__toggle:not([aria-hidden="true"])');
  assert((await toggles.count()) > 0, 'a heading with children should have a collapse toggle');
  log(`outline open with ${before} entries ✓`);

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page
    .locator('.markdown-toc')
    .screenshot({ path: join(shotDir, 'markdown-toc.png') })
    .catch(() => {});

  // Collapsing the first parent hides its nested entries.
  await toggles.first().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.markdown-toc__item').length < n,
    before,
    { timeout: 5000 },
  );
  const collapsed = await items.count();
  assert(collapsed < before, `collapse should hide entries (${before} → ${collapsed})`);
  log(`collapse hid ${before - collapsed} nested entries ✓`);

  // Expanding restores them.
  await page.locator('.markdown-toc__toggle:not([aria-hidden="true"])').first().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.markdown-toc__item').length === n,
    before,
    { timeout: 5000 },
  );
  log('expand restored the entries ✓');

  await closeApp(app, page);
});

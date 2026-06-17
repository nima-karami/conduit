/**
 * Live working-tree monitoring: a file created on disk shows up in the Files tree WITHOUT
 * the window being refocused — proving the host's debounced project watcher pushes
 * `fsChanged` and the renderer re-reads the tree from it (not from a focus event).
 *
 * Uses a throwaway temp project dir (never the repo). Windows-only like the rest of the suite.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[live-watch] SKIP — suite is Windows-only');
  process.exit(0);
}

const project = mkdtempSync(join(tmpdir(), 'conduit-live-'));

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  const log = (...a) => console.log('[live-watch]', ...a);

  await openSession(page, { path: project });
  await tapBridge(page);
  await page.locator('.rtab', { hasText: 'Files' }).click();
  // Let the host arm the project watcher (it does so when the renderer requests the project).
  await page.waitForTimeout(1200);

  // Create a file on disk from OUTSIDE the renderer; do NOT fire any focus/visibility event.
  writeFileSync(join(project, 'live.txt'), 'created externally');
  log('wrote live.txt to disk (no refocus)');

  const appeared = await page
    .locator('.filerow', { has: page.locator('.filerow__name', { hasText: /^live\.txt$/ }) })
    .first()
    .waitFor({ state: 'attached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  assert(appeared, 'a file created on disk should appear in the tree live (via fsChanged)');
  log('file appeared in the tree live — watcher → fsChanged → re-read ✓');

  await launched.cleanup();
  console.log('[live-watch] PASS ✓');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.log(`[live-watch] ${isAssertion ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
} finally {
  rmSync(project, { recursive: true, force: true });
}

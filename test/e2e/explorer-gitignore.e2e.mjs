/**
 * Explorer git-ignored dimming (real-app smoke).
 *
 * The Explorer shows build/dependency dirs (only VCS/OS metadata is hidden), but
 * git-ignored entries are dimmed (filerow--ignored). Drives the real app + the host
 * `git check-ignore` round-trip: node_modules (ignored) is dimmed; src (tracked) is not.
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

runScenario('explorer-gitignore', async ({ page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 20000 });

  const nm = fileRow(page, 'node_modules').first();
  await nm.waitFor({ state: 'attached', timeout: 20000 });
  const nmClass = (await nm.getAttribute('class')) ?? '';
  assert(nmClass.includes('filerow--ignored'), 'node_modules (git-ignored) should be dimmed');
  log('node_modules dimmed ✓');

  const src = fileRow(page, 'src').first();
  await src.waitFor({ state: 'attached', timeout: 20000 });
  const srcClass = (await src.getAttribute('class')) ?? '';
  assert(!srcClass.includes('filerow--ignored'), 'src (tracked) should NOT be dimmed');
  log('src not dimmed ✓');
});

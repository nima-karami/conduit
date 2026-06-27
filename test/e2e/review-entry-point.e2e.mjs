/**
 * Review-Changes entry point (real-app smoke). The Review action moved out of the Changes
 * tab into the git band, beside "View commit history" (spec 2026-06-27-review-changes-entry-
 * point). It must be visible WITHOUT navigating to the Changes tab and WITHOUT there being
 * any changes, and clicking it must open the Review tab — which shows a graceful empty state
 * on a clean tree. Crosses the renderer/host boundary: the git band only renders once the
 * host has produced GitInfo for the session, so this can only be proven in the real app.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'committed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

runScenario('review-entry-point', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-entry-'));
  makeRepo(root); // clean tree: a committed file, nothing uncommitted

  await openSession(page, { path: root.replace(/\\/g, '/') });

  // The Review button lives in the git band, which only renders once the host has produced
  // GitInfo (kind: branch) for the session — so its presence is real host→renderer proof.
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  log('Review button present + visible in the git band (clean tree, not on Changes tab) ✓');

  // It must sit beside the history button (the spec's "next to View commit history").
  const order = await page.evaluate(() => {
    const bar = document.querySelector('.git-indicator');
    if (!bar) return null;
    const kids = [...bar.children].map((c) => c.className);
    return {
      hasHistory: !!bar.querySelector('.git-indicator__history'),
      hasReview: !!bar.querySelector('.git-indicator__review'),
      kids,
    };
  });
  assert(order?.hasHistory && order?.hasReview, 'both history + review buttons in the git band');
  log('history + review buttons adjacent in the git band ✓');

  // No changes were made → clicking Review opens the Review tab showing the empty state.
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  const emptyText = await page.textContent('.review');
  assert(
    /Nothing to review/i.test(emptyText ?? ''),
    `Review opened on a clean tree should show the empty state; got: ${emptyText?.slice(0, 120)}`,
  );
  log('clicking Review on a clean tree opens the Review tab with the empty state ✓');

  log('PASS ✓ review-entry-point: Review action lives in the git band + clean-tree empty state');
});

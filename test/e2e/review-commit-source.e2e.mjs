/**
 * Review tab — commit source (real-app smoke). The Review tab can show a SPECIFIC commit's
 * changes, not only the working tree (spec 2026-06-29-review-commit-source). This crosses the
 * host/IPC boundary: a commit's files come from the host running `git show`, which the mock
 * preview / webview harness can't run — so it must be proven in the real app.
 *
 * Flow: open a session on a temp repo with two commits touching DISTINCT files (+ an
 * uncommitted working change) → open History → select the top commit → click the new
 * "Review changes" button in the commit detail → assert the Review tab opens showing exactly
 * that commit's files (each card's diff preloaded) → switch the breadcrumb back to Working
 * tree → assert it shows the working-tree change instead. Same singleton Review tab throughout.
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
  // Commit 1 adds alpha.txt.
  writeFileSync(join(dir, 'alpha.txt'), 'alpha v1\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'add alpha'], { cwd: dir });
  // Commit 2 (the most-recent / top row) adds beta.txt — a DISTINCT file.
  writeFileSync(join(dir, 'beta.txt'), 'beta one\nbeta two\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'add beta'], { cwd: dir });
  // Uncommitted working change to alpha.txt so the working-tree review is non-empty + DISTINCT
  // from the reviewed commit's file set.
  writeFileSync(join(dir, 'alpha.txt'), 'alpha v1\nalpha v2 (uncommitted)\n');
}

runScenario('review-commit-source', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-commit-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  // Open History from the git band (the spec entry point); the band only renders once the
  // host produced GitInfo, so its presence is real host→renderer proof.
  await page.waitForSelector('.git-indicator__history', { state: 'attached', timeout: 20000 });
  await page.click('.git-indicator__history', { force: true });
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 15000 });

  // Select the top (most-recent) commit → "add beta" → its inline detail lists beta.txt.
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__detail .commitview .gh__file', {
    state: 'attached',
    timeout: 15000,
  });
  const commitFiles = await page.$$eval('.gh__detail .commitview .gh__file-path', (els) =>
    els.map((e) => (e.textContent ?? '').trim()).sort(),
  );
  log(`commit detail lists: ${JSON.stringify(commitFiles)}`);
  assert(
    commitFiles.includes('beta.txt') && !commitFiles.includes('alpha.txt'),
    `expected the top commit to touch beta.txt only; got ${JSON.stringify(commitFiles)}`,
  );

  // Click the new "Review changes" button in the commit detail.
  await page.waitForSelector('.gh__review-commit', { state: 'attached', timeout: 8000 });
  await page.click('.gh__review-commit', { force: true });

  // The singleton Review tab opens with source = that commit and renders its files.
  await page.waitForSelector('.review', { state: 'attached', timeout: 12000 });
  await page.waitForSelector('.review .rcard', { state: 'attached', timeout: 12000 });
  const reviewFiles = await page.$$eval('.review .rcard', (els) =>
    els.map((e) => e.getAttribute('data-path') ?? '').sort(),
  );
  log(`review (commit source) cards: ${JSON.stringify(reviewFiles)}`);
  assert(
    JSON.stringify(reviewFiles) === JSON.stringify(commitFiles),
    `expected the Review tab to show exactly the commit's files; got ${JSON.stringify(reviewFiles)}`,
  );

  // The breadcrumb states the commit source.
  const sourceLabel = await page.textContent('.review__source');
  log(`review source label: ${JSON.stringify(sourceLabel)}`);
  assert(
    /commit/i.test(sourceLabel ?? ''),
    `expected the source breadcrumb to name the commit; got ${JSON.stringify(sourceLabel)}`,
  );

  // Each commit card's diff is PRELOADED (no per-card spinner) — beta.txt's added lines render.
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.review .rcard[data-path="beta.txt"]');
      return !!card && !/Loading diff/i.test(card.textContent ?? '');
    },
    null,
    { timeout: 10000 },
  );
  log('PASS: commit review shows the commit files with preloaded diffs ✓');

  // Switch the breadcrumb back to Working tree (same singleton tab).
  await page.click('.review__source', { force: true });
  await page.waitForSelector('.ctxmenu', { state: 'attached', timeout: 5000 });
  await page.click('.ctxmenu__item:has-text("Working tree")', { force: true });

  // Now the SAME tab shows the working-tree change (alpha.txt, modified, uncommitted) — and
  // NOT the commit's beta.txt.
  await page.waitForSelector('.review .rcard[data-path="alpha.txt"]', {
    state: 'attached',
    timeout: 12000,
  });
  const workingFiles = await page.$$eval('.review .rcard', (els) =>
    els.map((e) => e.getAttribute('data-path') ?? '').sort(),
  );
  log(`review (working source) cards: ${JSON.stringify(workingFiles)}`);
  assert(
    workingFiles.includes('alpha.txt') && !workingFiles.includes('beta.txt'),
    `expected working-tree review to show alpha.txt (not the commit's beta.txt); got ${JSON.stringify(workingFiles)}`,
  );

  // Exactly one Review tab existed throughout (singleton retarget, not a second tab).
  const reviewTabs = await page.evaluate(
    () => document.querySelectorAll('[data-tabid="review:@review"]').length,
  );
  assert(reviewTabs === 1, `expected exactly one Review tab; found ${reviewTabs}`);

  log('PASS ✓ review-commit-source: commit source ⇄ working tree in the singleton Review tab');
});

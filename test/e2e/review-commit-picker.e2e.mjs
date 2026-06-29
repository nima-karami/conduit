/**
 * Review-tab commit picker (real-app smoke). The Review header's source control is a searchable
 * commit picker (docs/specs/2026-06-29-review-commit-picker.md): it loads recent commits over
 * the host `git:history` IPC, filters them, and re-scopes the Review page to the picked commit
 * (or back to the working tree). A pasted SHA crosses the host boundary too.
 *
 * Crosses the renderer/host boundary: the commit list streams from `git:history`, so the picker
 * can only be proven against the real built app, not the preview mock.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 *
 * Also captures TASTE screenshots (the conductor reviews them): the open picker dropdown and the
 * icon-only right-floated commit-detail Review button.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

function commit(dir, name, subject) {
  writeFileSync(join(dir, name), `content of ${name}\nsecond line\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', subject], { cwd: dir });
}

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init seed'], { cwd: dir });
  commit(dir, 'alpha.txt', 'add alpha apple');
  commit(dir, 'beta.txt', 'add beta banana');
  commit(dir, 'gamma.txt', 'add gamma grape');
  // A dirty working-tree change so returning to "Working tree" shows a distinct card (alpha.txt),
  // not the commit's file — proving the source actually switched.
  appendFileSync(join(dir, 'alpha.txt'), 'a working-tree edit\n');
}

runScenario('review-commit-picker', async ({ page, log }) => {
  const shot1 = join(tmpdir(), 'conduit-shot-picker-1.png');
  const shot2 = join(tmpdir(), 'conduit-shot-picker-2.png');
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-picker-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  log('Review tab open');

  // Open the picker; the recent-commits list (sha + subject) must render from git:history.
  await page.click('.review__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  const shaCount = await page
    .waitForFunction(() => document.querySelectorAll('.commit-picker__sha').length, null, {
      timeout: 15000,
    })
    .then((h) => h.jsonValue());
  assert(shaCount >= 3, `picker should list >=3 recent commits; got ${shaCount}`);
  const firstSubjects = await page.evaluate(() =>
    [...document.querySelectorAll('.commit-picker__row .commit-picker__subject')].map(
      (s) => s.textContent,
    ),
  );
  assert(
    firstSubjects.some((s) => /add gamma grape/.test(s ?? '')),
    `commit subjects should render in rows; got ${JSON.stringify(firstSubjects)}`,
  );
  log(`picker open: ${shaCount} commit rows with sha+subject ✓`);

  await page.screenshot({ path: shot1 });
  log(`screenshot (open picker): ${shot1}`);

  // Filter to a single commit by a unique subject token, then pick it.
  await page.fill('.commit-picker .git-branch-menu__filter', 'banana');
  await page.waitForFunction(
    () => document.querySelectorAll('.commit-picker__sha').length === 1,
    null,
    { timeout: 8000 },
  );
  log('filter "banana" narrows to one commit ✓');
  await page.click('.commit-picker__list .commit-picker__row:has(.commit-picker__sha)');

  // The Review page re-scopes to that commit: only its added file (beta.txt) shows.
  await page.waitForSelector('.rcard[data-path="beta.txt"]', { state: 'visible', timeout: 15000 });
  const cardsAfterCommit = await page.evaluate(() =>
    [...document.querySelectorAll('.rcard')].map((c) => c.getAttribute('data-path')),
  );
  assert(
    cardsAfterCommit.includes('beta.txt') && !cardsAfterCommit.includes('alpha.txt'),
    `commit review should show only beta.txt; got ${JSON.stringify(cardsAfterCommit)}`,
  );
  const labelCommit = await page.textContent('.review__source .gh__reffilter-label');
  assert(
    /add beta banana/.test(labelCommit ?? ''),
    `trigger label should show the picked commit subject; got "${labelCommit}"`,
  );
  log(`picked commit re-scopes Review to beta.txt; trigger label="${labelCommit}" ✓`);

  // Reopen the picker and return to the working tree.
  await page.click('.review__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  await page.click('.commit-picker__list .commit-picker__row:has(.commit-picker__working)');
  await page.waitForSelector('.rcard[data-path="alpha.txt"]', { state: 'visible', timeout: 15000 });
  const labelWorking = await page.textContent('.review__source .gh__reffilter-label');
  assert(
    /Working tree/.test(labelWorking ?? ''),
    `trigger label should return to "Working tree"; got "${labelWorking}"`,
  );
  log('picking "Working tree" returns the Review page to the working tree ✓');

  // Item 1: the commit-detail Review action is icon-only + right-floated. Open History, select a
  // commit, and inspect the .gh__review-commit button (no visible text, margin-left:auto).
  await page.waitForSelector('.git-indicator__history', { state: 'visible', timeout: 10000 });
  await page.click('.git-indicator__history');
  await page.waitForSelector('.gh__row', { state: 'visible', timeout: 15000 });
  await page.click('.gh__row');
  await page.waitForSelector('.gh__review-commit', { state: 'visible', timeout: 10000 });
  const reviewBtn = await page.evaluate(() => {
    const b = document.querySelector('.gh__review-commit');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { text: (b.textContent ?? '').trim(), marginLeft: cs.marginLeft, label: b.ariaLabel };
  });
  assert(reviewBtn !== null, 'commit-detail Review button present');
  assert(
    reviewBtn.text === '',
    `commit-detail Review button must be icon-only (no text); got "${reviewBtn.text}"`,
  );
  assert(
    reviewBtn.label === 'Review changes',
    `commit-detail Review button keeps the accessible name; got "${reviewBtn.label}"`,
  );
  assert(
    reviewBtn.marginLeft === 'auto' || parseFloat(reviewBtn.marginLeft) > 20,
    `commit-detail Review button should float right (margin-left:auto); got "${reviewBtn.marginLeft}"`,
  );
  log(`commit-detail Review button: icon-only, right-floated, aria="${reviewBtn.label}" ✓`);

  await page.screenshot({ path: shot2 });
  log(`screenshot (commit-detail Review button): ${shot2}`);

  log('PASS ✓ review-commit-picker: searchable picker re-scopes Review + icon-only Review action');
});

/**
 * Review "compare two refs" (real-app smoke). Spec 2026-06-29-review-changes-polish item 4.
 *
 * Crosses the renderer/host boundary: the comparison is computed host-side (git:rangeDiff over
 * git diff A...B with host-validated refs), so it can only be proven against the built app.
 *
 * Asserts: the git-band source picker's Compare… builder lets you pick a base branch and a target
 * branch and renders that comparison in Review; the trigger label reads "base…head"; identical
 * endpoints show the "No differences" empty state. Captures a taste screenshot of the builder.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

function git(dir, ...args) {
  execFileSync('git', args, { cwd: dir });
}

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init seed');
  // A feature branch that adds a file → main...feature shows feature-only.txt.
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'feature-only.txt'), 'a\nb\nc\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'add feature file');
  git(dir, 'checkout', '-q', 'main'); // land on main (feature-only.txt absent in the working tree)
}

const FILTER = '.commit-picker .git-branch-menu__filter';

runScenario('review-compare', async ({ page, log }) => {
  const shot = join(tmpdir(), 'conduit-shot-compare-builder.png');
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-compare-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });

  // Open the picker → enter the Compare builder.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  await page.click('.commit-picker__compare-entry');
  await page.waitForSelector('.commit-picker__compare', { state: 'visible', timeout: 5000 });
  log('compare builder open');

  // Base = main.
  await page.click('.commit-picker__field[aria-label="Base"]');
  await page.waitForSelector(FILTER, { state: 'visible', timeout: 5000 });
  await page.fill(FILTER, 'main');
  await page.click('.commit-picker__row:has-text("main")');
  await page.waitForSelector('.commit-picker__compare', { state: 'visible', timeout: 5000 });

  // Target = feature.
  await page.click('.commit-picker__field[aria-label="Target"]');
  await page.waitForSelector(FILTER, { state: 'visible', timeout: 5000 });
  await page.fill(FILTER, 'feature');
  await page.click('.commit-picker__row:has-text("feature")');
  await page.waitForSelector('.commit-picker__compare', { state: 'visible', timeout: 5000 });

  // Screenshot the built comparison before confirming (taste).
  await page.screenshot({ path: shot });
  log(`screenshot (compare builder): ${shot}`);

  await page.click('.commit-picker__confirm');

  // The Review page shows the feature-only file (main...feature, three-dot).
  await page.waitForSelector('.review .rcard[data-path="feature-only.txt"]', {
    state: 'visible',
    timeout: 15000,
  });
  const cards = await page.$$eval('.review .rcard', (els) =>
    els.map((e) => e.getAttribute('data-path')),
  );
  assert(
    cards.includes('feature-only.txt'),
    `compare main...feature should show feature-only.txt; got ${JSON.stringify(cards)}`,
  );
  const label = await page.textContent('.gitband__source .gh__reffilter-label');
  log(`compare trigger label: ${JSON.stringify(label)}`);
  assert(
    /main.*feature/.test(label ?? ''),
    `trigger label should read "main…feature"; got ${JSON.stringify(label)}`,
  );
  log('compare main...feature renders feature-only.txt with the base…head label ✓');

  // Identical endpoints → "No differences" empty state.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  await page.click('.commit-picker__compare-entry');
  await page.click('.commit-picker__field[aria-label="Base"]');
  await page.fill(FILTER, 'main');
  await page.click('.commit-picker__row:has-text("main")');
  await page.click('.commit-picker__field[aria-label="Target"]');
  await page.fill(FILTER, 'main');
  await page.click('.commit-picker__row:has-text("main")');
  await page.click('.commit-picker__confirm');
  // Poll the title (it passes through "Loading comparison…" before settling).
  await page.waitForFunction(
    () =>
      /no differences/i.test(
        document.querySelector('.review .emptystate__title')?.textContent ?? '',
      ),
    null,
    { timeout: 15000 },
  );
  const emptyTitle = await page.textContent('.review .emptystate__title');
  log(`identical-endpoints empty state: ${JSON.stringify(emptyTitle)}`);

  log('PASS ✓ review-compare: branch↔branch comparison + identical-endpoints empty state');
});

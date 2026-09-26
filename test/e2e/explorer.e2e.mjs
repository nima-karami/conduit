/**
 * Explorer state + reveal-on-open (real-app smoke).
 *
 * Covers two reported bugs:
 *  - #2: switching the active session must NOT collapse the file tree. Each project's
 *    expansion state is cached and restored, so switching back to a session shows the
 *    tree as you left it.
 *  - #3: opening a file from anywhere (here: the in-pane search) reveals it in the tree —
 *    the Files tab activates, the ancestor folders auto-expand, and the file row is
 *    highlighted.
 *
 * Driven against the REAL app (the Conduit repo itself is the opened project), so the
 * readDir/dirEntries host round-trips and the reveal expansion loop are exercised for real.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assert, openSession, REPO, runScenario } from './harness.mjs';

const NAME_A = basename(REPO); // repo-root session label (e.g. "conduit")

/**
 * Find-in-files stops at a 2s wall-clock budget, and on a fresh checkout (files never read since
 * they were written — a new worktree, a clean clone) reading this repo's ~1200 files takes longer
 * than that, so the search reports "Search stopped early" before it reaches webview/. Reading the
 * files once here puts the search this scenario depends on in the state any second search is in.
 */
function warmProjectFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' });
  for (const rel of tracked.split('\n').filter(Boolean)) {
    try {
      readFileSync(join(REPO, rel));
    } catch {
      // deleted in the working tree
    }
  }
}
warmProjectFiles();

// Locator helpers (kept inline so the scenario reads top-to-bottom).
const fileRowByName = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

runScenario('explorer', async ({ page, log }) => {
  // Two sessions rooted at DIFFERENT folders, so switching changes the explorer root.
  const sidA = await openSession(page, { path: REPO });
  log('session A (repo root) =', sidA);
  const sidB = await openSession(page, { path: join(REPO, 'src') });
  log('session B (src) =', sidB);

  // Switch the right pane to the Files tab.
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const activate = async (name) => {
    await page
      .locator('.session', { has: page.locator('.session__name', { hasText: name }) })
      .first()
      .click();
  };

  // ── Bug #2: tree state survives a session switch ──────────────────────────────
  await activate(NAME_A);
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 20000 });
  await fileRowByName(page, 'webview').first().waitFor({ state: 'attached', timeout: 20000 });

  // Expand 'webview' and wait for a stable child to appear.
  await fileRowByName(page, 'webview').first().click();
  await fileRowByName(page, 'app.tsx').first().waitFor({ state: 'attached', timeout: 20000 });
  log('expanded webview/ (app.tsx visible) ✓');

  // Switch to B (a different project root) — its tree has no 'webview'.
  await activate('src');
  await fileRowByName(page, 'webview')
    .first()
    .waitFor({ state: 'detached', timeout: 20000 })
    .catch(() => {});
  log('switched to session B (src) ✓');

  // Switch back to A. The expansion must be restored WITHOUT re-clicking webview.
  await activate(NAME_A);
  const restored = await fileRowByName(page, 'app.tsx')
    .first()
    .waitFor({ state: 'attached', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  assert(restored, 'webview/ should still be expanded after switching session away and back');
  log('tree expansion restored after session switch ✓');

  // ── Bug #3: opening from search reveals + highlights in the tree ──────────────
  // Collapse the home section (D3: every subfolder with it) so the reveal genuinely has to
  // re-expand the section and its ancestors.
  await page.locator(`.files__bar button[aria-label="Collapse ${NAME_A}"]`).click();
  await page
    .locator(`.files__bar button[aria-label="Expand ${NAME_A}"]`)
    .waitFor({ state: 'visible', timeout: 5000 });
  await fileRowByName(page, 'app.tsx')
    .first()
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => {});

  // Search for a token that lives ONLY in webview/components/right-pane.tsx (two levels
  // deep). If a refactor deletes it the wait below just times out, as if search hung — check
  // `git grep -w` first. Built by concatenation so this test file doesn't itself contain the
  // contiguous string (which would make it a search hit that sorts ahead of the intended target).
  const token = ['nextStatus', 'Text'].join('');
  const input = page.locator('.search__inputbox textarea');
  await input.click();
  await input.fill(token);
  const stoppedEarly = page.locator('.search .emptystate__title', {
    hasText: 'Search stopped early',
  });
  await page
    .locator('.searchmatch')
    .first()
    .or(stoppedEarly)
    .waitFor({ state: 'visible', timeout: 20000 });
  assert(
    !(await stoppedEarly.isVisible()),
    'PRECONDITION (machine, not product): find-in-files hit its 2s time budget before reaching webview/ even after the files were pre-read — the disk is too slow or too contended right now. Re-run on a quiet machine.',
  );
  log('search produced results ✓');

  // Open the hit — this routes through the same openFile path every opener uses.
  await page.locator('.searchmatch').first().click();

  // The reveal should: switch to the tree (search cleared), expand ancestors, highlight file.
  const revealed = page.locator('.filerow--revealed');
  await revealed.first().waitFor({ state: 'attached', timeout: 20000 });
  const revealedName = await revealed.first().locator('.filerow__name').innerText();
  assert(
    revealedName.trim() === 'right-pane.tsx',
    `revealed row should be right-pane.tsx, got "${revealedName}"`,
  );

  // Ancestor folders auto-expanded. The tree is windowed (only viewport rows mount), and the
  // reveal scrolls the deep target (right-pane.tsx) into view — its ancestor `components` sits
  // many rows above (webview/components has many files), so it's legitimately outside the mounted
  // window. Scroll to the top to bring the ancestors into the window, then assert `components`
  // mounted — proving it's expanded AND present in the list, not just that it happened to be on
  // screen right after the reveal.
  await page.locator('.rightpane__scroll--files').evaluate((el) => {
    el.scrollTop = 0;
  });
  await fileRowByName(page, 'components').first().waitFor({ state: 'attached', timeout: 10000 });

  // Search results were cleared (we're back on the tree, not the results list).
  await page
    .locator('.searchmatch')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {});
  const stillSearching = await page.locator('.searchmatch').count();
  assert(stillSearching === 0, 'search results should be cleared after revealing the file');
  log('reveal-on-open: ancestors expanded + file highlighted + search cleared ✓');
});

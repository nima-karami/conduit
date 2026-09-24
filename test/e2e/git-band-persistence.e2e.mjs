/**
 * The git entry points survive opening a document. Git lives in the Changes tab now
 * (docs/specs/2026-09-23-mf-changes.md §2.1, §2.4, §7.4): whatever doc is active, the Changes
 * header's Review button and the repo head's branch chip stay present and operable, and the tab
 * row holds no git chrome.
 *
 * Originally (spec 2026-06-27-review-changes-entry-point) the tab-row git band was gated on the
 * active doc, so opening an ordinary file took Review and History off screen with no hint of how
 * to get them back. Reported as "the git history and review changes icons are gone!"
 *
 * Windows only, real app — see CLAUDE.md (run alone on a quiet machine).
 */

import { assert, openChangesTab, openSession, REPO, runScenario } from './harness.mjs';

/** What the git entry points look like right now. */
const survey = (page) =>
  page.evaluate(() => {
    const live = (s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return !el.disabled && r.width > 0 && r.height > 0;
    };
    const sel =
      '.git-indicator, .repo-picker, .branch-chip, .changes__review, [class*="git-indicator"], [class*="repo-picker"]';
    const rows = [...document.querySelectorAll('.tabbar-wrap')];
    return {
      review: live('.changes__review'),
      chip: live('.repo-head .branch-chip'),
      tabRows: rows.length,
      tabRowGit: rows.reduce((n, r) => n + r.querySelectorAll(sel).length, 0),
      activeTab: document.querySelector('.tab--active')?.textContent?.trim() ?? '(none)',
    };
  });

function assertAllPresent(state, where) {
  assert(state.review, `${where}: the Review button must be on screen and enabled`);
  assert(state.chip, `${where}: the branch chip must be on screen and enabled`);
  assert(state.tabRows > 0, `${where}: the tab row must be rendered`);
  assert(state.tabRowGit === 0, `${where}: the tab row holds ${state.tabRowGit} git control(s)`);
}

/** The chip is operable, not just painted: its menu opens with View history, then closes. */
async function assertChipOpens(page, where) {
  await page.locator('.repo-head .branch-chip').first().click();
  const item = page.locator('.branch-chip-menu [role="menuitem"]', { hasText: 'View history' });
  await item.waitFor({ state: 'visible', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.locator('.branch-chip-menu').waitFor({ state: 'detached', timeout: 5000 });
  return `${where}: chip menu opened ✓`;
}

runScenario('git-band-persistence', async ({ page, log }) => {
  // Conduit's own checkout: a real repo, so the chip resolves a branch.
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/') });
  log('session running:', sid);
  await page.waitForSelector('.termpane', { state: 'attached', timeout: 25000 });
  await openChangesTab(page);
  await page.waitForFunction(
    () => document.querySelector('.repo-head .branch-chip')?.disabled === false,
    null,
    { timeout: 30000 },
  );

  const onTerminal = await survey(page);
  assertAllPresent(onTerminal, 'terminal');
  log(await assertChipOpens(page, 'terminal'));
  log('terminal: review + chip present, tab row clean ✓');

  // Open an ordinary file from the explorer — the case that used to blank the band.
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Files'))
      ?.click();
  });
  const row = page.locator('.filerow', { hasText: 'package.json' }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  await row.click();
  await page.waitForFunction(
    () => document.querySelector('.tab--active')?.textContent?.includes('package.json'),
    null,
    { timeout: 20000 },
  );
  await openChangesTab(page);

  const onDoc = await survey(page);
  assert(
    onDoc.activeTab.includes('package.json'),
    `the editor doc must be the active tab, got "${onDoc.activeTab}"`,
  );
  assertAllPresent(onDoc, 'editor doc open');
  log(await assertChipOpens(page, 'editor doc open'));
  log('editor doc: review + chip still present, tab row clean ✓');

  // And Review is live, not just painted: it opens the Review doc.
  await page.locator('.changes__review').first().click();
  await page.waitForFunction(() => !!document.querySelector('.review'), null, { timeout: 25000 });
  log('Review button opened Review from a doc tab ✓');
});

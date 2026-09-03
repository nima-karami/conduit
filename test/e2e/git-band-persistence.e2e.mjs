/**
 * The git band survives opening a document (spec 2026-06-27-review-changes-entry-point).
 *
 * Review and History are REPO-scoped actions, and the git band is their only entry point. It
 * used to be gated on `!showDoc || gitScopedDoc`, so opening any ordinary file — an editor
 * tab, a markdown preview, a PDF — took the branch indicator, Review, History and Compare off
 * screen with no hint of why or how to get them back; the user had to guess that switching
 * back to the terminal tab restored them. Reported as "the git history and review changes
 * icons are gone!"
 *
 * Windows only, real app — see CLAUDE.md (run alone on a quiet machine).
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

/** What the git band is showing right now. */
const survey = (page) =>
  page.evaluate(() => {
    const has = (s) => !!document.querySelector(s);
    return {
      band: has('.git-indicator'),
      history: has('.git-indicator__history'),
      review: has('.git-indicator__review'),
      compare: has('.git-indicator__compare'),
      activeTab: document.querySelector('.tab--active')?.textContent?.trim() ?? '(none)',
    };
  });

function assertAllPresent(state, where) {
  assert(state.band, `${where}: the git band must be on screen (active tab "${state.activeTab}")`);
  assert(state.history, `${where}: the commit-history button must be on screen`);
  assert(state.review, `${where}: the review-changes button must be on screen`);
  assert(state.compare, `${where}: the compare button must be on screen`);
}

runScenario('git-band-persistence', async ({ page, log }) => {
  // Conduit's own checkout: a real repo, so the indicator resolves a branch rather than
  // self-hiding on git kind 'none'.
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/') });
  log('session running:', sid);
  await page.waitForSelector('.termpane', { state: 'attached', timeout: 25000 });
  await page.locator('.git-indicator').first().waitFor({ state: 'visible', timeout: 30000 });

  const onTerminal = await survey(page);
  assertAllPresent(onTerminal, 'terminal');
  log('terminal: band + history + review + compare ✓');

  // Open an ordinary file from the explorer — the case that used to blank the band.
  const row = page.locator('.filerow', { hasText: 'package.json' }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  await row.click();
  await page.waitForFunction(
    () => document.querySelector('.tab--active')?.textContent?.includes('package.json'),
    null,
    { timeout: 20000 },
  );

  const onDoc = await survey(page);
  assert(
    onDoc.activeTab.includes('package.json'),
    `the editor doc must be the active tab, got "${onDoc.activeTab}"`,
  );
  assertAllPresent(onDoc, 'editor doc open');
  log('editor doc: band + history + review + compare still on screen ✓');

  // And the buttons are live, not just painted: Review opens the Review doc.
  await page.locator('.git-indicator__review').first().click();
  await page.waitForFunction(() => !!document.querySelector('.review'), null, { timeout: 25000 });
  log('review button opened Review from a doc tab ✓');
});

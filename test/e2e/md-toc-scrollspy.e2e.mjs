/**
 * Markdown outline click-pinning, with a long doc whose final SEVERAL sections are all
 * short (so they share one bottomed-out scroll position): clicking an outline entry
 * must make THAT entry active and keep it active — even the second-to-last, which
 * scroll position alone can't distinguish from the last once the container bottoms out.
 *
 * Reproduces the reported bug: "if I click the second-last section it switches to the
 * very last." The fix pins the clicked entry (the click handler sets the active id
 * synchronously) so scroll-spy yields to it.
 *
 * Note: the scroll-POSITION half of scroll-spy (the bottom-snap math in pickActiveIndex)
 * is covered by unit tests, not here — under the hidden CONDUIT_E2E launch the window is
 * occluded and requestAnimationFrame never fires, so the rAF-scheduled scroll recompute
 * can't be exercised. The click path sets the active id synchronously, so it IS testable.
 *
 * Driven against the REAL app with a synthesized doc written into the opened repo and
 * removed afterwards.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, openSession, REPO, runScenario } from './harness.mjs';

const DOC_NAME = '__md-toc-scrollspy-repro.md';
const DOC_PATH = join(REPO, DOC_NAME);

const FILLER = Array.from(
  { length: 30 },
  (_, i) => `Filler line ${i + 1} for vertical height.`,
).join('\n\n');

const SHORT_TRAILING = ['Short A', 'Short B', 'Short C'];

const buildDoc = () => {
  const parts = ['# Repro: long outline\n'];
  for (let i = 1; i <= 9; i++) {
    parts.push(`## Section ${i}\n\n${FILLER}\n`);
  }
  // Several deliberately tiny trailing sections — together shorter than the viewport,
  // so any of them bottoms the container out and they share one scroll position.
  for (const name of SHORT_TRAILING) {
    parts.push(`## ${name}\n\nThe end.\n`);
  }
  return parts.join('\n');
};

const isActive = (item) =>
  item.evaluate((el) => el.classList.contains('markdown-toc__item--active'));

runScenario('md-toc-scrollspy', async ({ page, log }) => {
  writeFileSync(DOC_PATH, buildDoc());
  try {
    await openSession(page, { path: REPO });
    await page.locator('.rtab', { hasText: 'Files' }).click();

    const row = page.locator('.filerow', {
      has: page.locator('.filerow__name', { hasText: new RegExp(`^${DOC_NAME}$`) }),
    });
    await row.first().waitFor({ state: 'attached', timeout: 20000 });
    await row.first().click();
    await page
      .locator('.markdown h1, .markdown h2')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 });

    await page.locator('.viewer__toggle', { hasText: /^Outline$/ }).click();
    const items = page.locator('.markdown-toc__item');
    const count = await items.count();
    assert(count >= 12, `expected ≥12 outline entries, got ${count}`);

    const last = items.nth(count - 1);
    const secondLast = items.nth(count - 2);
    const lastText = (await last.textContent())?.trim();
    const secondLastText = (await secondLast.textContent())?.trim();

    // Clicking the LAST (short final) entry activates it — the original bug was that a
    // short final section's heading can't reach the reading line, so it never lit up.
    await last.click();
    await page.waitForTimeout(200);
    assert(await isActive(last), `clicking the last entry "${lastText}" must activate it`);
    log(`clicked last "${lastText}" → active ✓`);

    // Clicking the SECOND-TO-LAST entry keeps THAT entry active (not the last) — the
    // reported regression where it jumped to the very last section.
    await secondLast.click();
    await page.waitForTimeout(200);
    assert(
      await isActive(secondLast),
      `clicking the second-to-last entry "${secondLastText}" must keep it active`,
    );
    assert(
      !(await isActive(last)),
      `the last entry must NOT be active after clicking the second-to-last`,
    );
    log(`clicked second-to-last "${secondLastText}" stays active, last not ✓`);
  } finally {
    rmSync(DOC_PATH, { force: true });
  }
});

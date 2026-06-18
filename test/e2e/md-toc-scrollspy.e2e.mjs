/**
 * Markdown outline scroll-spy: with a long doc whose final section is short, the
 * last outline entry must be active once the reader scrolls to the bottom.
 *
 * Repro for the bug where the scroll container bottoms out before the short final
 * section's heading can reach the reading line, so an earlier section stayed active.
 * Driven against the REAL app with a synthesized 13-heading doc (short last section)
 * written into the opened repo and removed afterwards.
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

const buildDoc = () => {
  const parts = ['# Repro: long outline\n'];
  for (let i = 1; i <= 11; i++) {
    parts.push(`## Section ${i}\n\n${FILLER}\n`);
  }
  // Deliberately tiny final section — one line, no filler.
  parts.push('## Final short section\n\nThe end.\n');
  return parts.join('\n');
};

const scrollAndSettle = (page, top) =>
  page.evaluate(async (t) => {
    const c = document.querySelector('.markdown');
    c.scrollTop = t === 'bottom' ? c.scrollHeight : t;
    c.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 350));
  }, top);

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

    // Scroll through a mid section first so the spy has a non-initial baseline,
    // then to the bottom — mirrors a real reader and avoids asserting on the
    // mount-time active state.
    await scrollAndSettle(page, 5600);
    const midActive = (
      await page.locator('.markdown-toc__item--active').first().textContent()
    )?.trim();
    log(`active at mid-scroll: ${midActive}`);

    await scrollAndSettle(page, 'bottom');

    const metrics = await page.evaluate(() => {
      const c = document.querySelector('.markdown');
      return { scrollTop: c.scrollTop, clientHeight: c.clientHeight, scrollHeight: c.scrollHeight };
    });
    assert(
      metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2,
      `container must be bottomed out to exercise the bug; metrics=${JSON.stringify(metrics)}`,
    );
    log(`bottomed out: ${JSON.stringify(metrics)}`);

    const shot = process.env.MD_TOC_SHOT;
    if (shot) await page.screenshot({ path: shot });

    const activeText = (
      await page.locator('.markdown-toc__item--active').first().textContent()
    )?.trim();
    const lastIsActive = await last.evaluate((el) =>
      el.classList.contains('markdown-toc__item--active'),
    );
    assert(
      lastIsActive,
      `last outline entry must be active at the bottom; active was "${activeText}"`,
    );
    log(`last entry "${activeText}" active at the bottom ✓`);
  } finally {
    rmSync(DOC_PATH, { force: true });
  }
});

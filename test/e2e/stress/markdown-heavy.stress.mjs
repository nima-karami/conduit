/**
 * Markdown viewer under a heavy document — hundreds of headings + fenced code blocks
 * (rehypeHighlight runs on every block) and dozens of mermaid fences (one render each). The
 * viewer renders the whole doc in one pass with no virtualization, so this is a soft spot.
 *
 * Invariant (fails the lane): the doc renders (headings present) and find highlights a match.
 * Advisory: full render time, find open + query latency, frames during render.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  makeHeavyMarkdown,
  measureUntil,
  openSession,
  runStress,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';

const SECTIONS = 300;
const MERMAID = 40;

runStress('markdown-heavy', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-md-heavy-'));
  makeHeavyMarkdown(join(root, 'heavy.md'), { sections: SECTIONS, mermaid: MERMAID });
  await openSession(page, { path: root });

  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 25000 });

  const renderStart = Date.now();
  await startPerf(page, 'markdown-heavy');
  await page.locator('.filerow', { hasText: 'heavy.md' }).first().click();
  await page.waitForSelector('.markdown', { state: 'visible', timeout: 30000 });
  // Wait until most headings have rendered (the full-doc parse has landed).
  await page.waitForFunction(
    (n) => document.querySelectorAll('.markdown h2').length >= n,
    SECTIONS - 1,
    { timeout: 45000 },
  );
  const report = await stopPerf(page);
  const renderMs = Date.now() - renderStart;

  const headings = await page.evaluate(() => document.querySelectorAll('.markdown h2').length);
  const codeBlocks = await page.evaluate(
    () => document.querySelectorAll('.markdown pre code').length,
  );
  log(`rendered headings=${headings} codeBlocks=${codeBlocks} in ${renderMs}ms`);
  assertInvariant(headings >= SECTIONS - 1, `expected ~${SECTIONS} headings, got ${headings}`);

  // Open find (Ctrl+F), query a term matching many sections, and time until highlights appear.
  await page.locator('.markdown').click();
  const findLatencyMs = await measureUntil(
    page,
    async () => {
      await page.keyboard.press('Control+f');
      await page.keyboard.type('Section');
    },
    () => {
      try {
        return (CSS.highlights?.get('md-find')?.size ?? 0) > 0;
      } catch {
        return false;
      }
    },
    { timeout: 15000 },
  );
  // INVARIANT: find produced highlights (CSS Custom Highlight API).
  const hasHighlights = await page.evaluate(() => (CSS.highlights?.get('md-find')?.size ?? 0) > 0);
  log(`find latency=${findLatencyMs}ms highlights=${hasHighlights}`);
  assertInvariant(hasHighlights, 'find should highlight matches in the rendered markdown');

  emitReport('markdown-heavy', report, { renderMs, headings, codeBlocks, findLatencyMs });
});

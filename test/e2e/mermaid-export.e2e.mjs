/**
 * Mermaid diagram export (spec 2026-07-01-mermaid-export).
 *
 * Drives the REAL app: opens a temp markdown doc that contains a mermaid fenced block,
 * renders it, opens the zoom overlay, and exercises the toolbar's Export SVG action —
 * capturing the browser download and asserting the saved file is a valid, non-empty SVG.
 *
 * PNG rasterization needs a real canvas/Image (jsdom can't), so it's only reachable here;
 * this scenario asserts the SVG path end-to-end and that the PNG button is present.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

const FIXTURE = `# Diagram

\`\`\`mermaid
graph TD
  A[Start] --> B{Choice}
  B -->|yes| C[Do the thing]
  B -->|no| D[Skip]
\`\`\`
`;

runScenario('mermaid-export', async ({ app, page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-mermaid-'));
  writeFileSync(join(dir, 'diagram.md'), FIXTURE);

  await openSession(page, { path: dir });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^diagram\.md$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();

  // Mermaid renders async (rAF + mermaid.render); wait for the injected <svg>.
  await page
    .locator('.mermaid-diagram__svg svg')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  log('mermaid diagram rendered ✓');

  // The __expand button is hover-only (opacity:0/pointer-events:none until hover); the
  // always-visible __svg body is the sibling click target that also opens the overlay.
  await page.locator('.mermaid-diagram__svg').first().click();
  await page.locator('.mermaid-zoom__controls').waitFor({ state: 'visible', timeout: 5000 });
  log('zoom overlay opened ✓');

  const svgBtn = page.locator('.mermaid-zoom__btn[aria-label="Export as SVG"]');
  const pngBtn = page.locator('.mermaid-zoom__btn[aria-label="Export as PNG"]');
  await svgBtn.waitFor({ state: 'visible', timeout: 5000 });
  assert((await pngBtn.count()) === 1, 'Export PNG button should be present');
  log('Export SVG + PNG buttons present ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  await page
    .locator('.mermaid-zoom__controls')
    .screenshot({ path: join(shotDir, 'mermaid-export-toolbar.png') })
    .catch(() => {});

  // Capture the exact blob the export produces through the REAL code path
  // (button -> exportSvg -> svgToBlob -> download), while neutralizing the anchor click
  // so Electron's native Save dialog — invisible to this hidden harness
  // ([[playwright-cannot-drive-native-dialogs]]) — never opens and hangs the run. The
  // actual file write behind that dialog is needs-human-smoke.
  await page.evaluate(() => {
    const w = /** @type {Record<string, unknown>} */ (window);
    w.__exportBlobText = null;
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      void blob.text().then((t) => {
        w.__exportBlobText = t;
      });
      return origCreate(blob);
    };
    HTMLAnchorElement.prototype.click = () => {};
  });
  await svgBtn.click();
  await page.waitForFunction(() => window.__exportBlobText !== null, { timeout: 5000 });
  const content = /** @type {string} */ (await page.evaluate(() => window.__exportBlobText));
  assert(content.length > 0, 'exported SVG must be non-empty');
  assert(
    content.startsWith('<?xml') || content.trimStart().startsWith('<svg'),
    `exported SVG should start with <?xml or <svg, got: ${content.slice(0, 40)}`,
  );
  assert(content.includes('<svg'), 'exported blob should contain an <svg> element');
  log(`Export SVG produced a valid standalone SVG (${content.length} bytes) ✓`);

  await closeApp(app, page);
});

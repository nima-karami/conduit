/**
 * Markdown relative/local images (real-app smoke). An agent embeds a generated chart in a report
 * as `![](./chart.png)`; the rendered Markdown view must show it, not a broken icon. Crosses the
 * host boundary (the image bytes come back as a data URL via the new md:image IPC), so it can only
 * be proven against the built app — the preview mock returns an error by design.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

// A real 1x1 red PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

runScenario('md-images', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-md-images-'));
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'out', 'chart.png'), Buffer.from(PNG_B64, 'base64'));
  writeFileSync(
    join(root, 'report.md'),
    '# Report\n\nHere is the chart the agent made:\n\n![the chart](./out/chart.png)\n\nMissing one: ![gone](./nope.png)\n',
  );

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^report\.md$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.locator('.markdown h1').first().waitFor({ state: 'visible', timeout: 20000 });
  log('report.md rendered ✓');

  // The relative image resolves to a data: URL through the host and renders as a real <img>.
  const img = page.locator('.markdown img');
  await img.first().waitFor({ state: 'visible', timeout: 10000 });
  const probe = await page.evaluate(() => {
    const el = document.querySelector('.markdown img');
    return {
      src: el?.getAttribute('src') ?? '',
      naturalWidth: el instanceof HTMLImageElement ? el.naturalWidth : 0,
      broken: !!document.querySelector('.markdown-img-status--broken'),
    };
  });
  log(`img src prefix: ${probe.src.slice(0, 24)} naturalWidth=${probe.naturalWidth}`);
  assert(
    probe.src.startsWith('data:image/'),
    `relative image should load as a data URL, got "${probe.src.slice(0, 40)}"`,
  );
  assert(probe.naturalWidth > 0, 'the resolved image should actually decode (naturalWidth > 0)');
  assert(probe.broken, 'the missing image should show the broken/not-found affordance');
  log('relative image rendered; missing image showed the not-found affordance ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'md-images.png') }).catch(() => {});

  await closeApp(app, page);
});

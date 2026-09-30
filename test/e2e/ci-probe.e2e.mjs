/**
 * SPIKE ONLY (remote-e2e plan, Slice 0), never merged: proves a hidden (`show:false`) window can
 * be screenshotted and that Playwright tracing works on the Electron context. The tracing half is
 * the harness's E2E_PROBE_DIR hook, which this scenario requires.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { assert, closeApp, runScenario } from './harness.mjs';

runScenario('ci-probe', async ({ app, page, log }) => {
  const dir = process.env.E2E_PROBE_DIR;
  assert(dir, 'E2E_PROBE_DIR must be set');
  await page.waitForSelector('.tabbar-wrap', { state: 'attached', timeout: 20000 });

  const visible = await app.evaluate((e) =>
    e.BrowserWindow.getAllWindows().map((w) => w.isVisible()),
  );
  log(`window visibility: ${JSON.stringify(visible)}`);

  const path = join(dir, 'ci-probe-direct.png');
  const t = Date.now();
  await page.screenshot({ path, timeout: 15000 });
  const bytes = statSync(path).size;
  log(`direct screenshot: ${Date.now() - t} ms, ${bytes} bytes`);
  assert(bytes > 1000, `screenshot of the hidden window is empty (${bytes} bytes)`);

  await closeApp(app, page);
});

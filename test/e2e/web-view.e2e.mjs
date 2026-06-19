/**
 * web-view — in-app browser tab (FULL)
 *
 * Drives the REAL app (the <webview> tag only exists in Electron, not the browser
 * preview). Serves a fixture page over http on 127.0.0.1, opens a web tab through the
 * real flow (command palette → "Open web page…" → URL prompt), and asserts:
 *   - the <webview> mounts with the fixture src
 *   - the page loads → page-title-updated → the tab label adopts the page <title>
 *   - Back is disabled on the first page
 *   - navigating the address bar to a dead port surfaces the in-tab error panel
 *
 * Windows-only (matches the suite).
 */

import { createServer } from 'node:http';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[web-view] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('web-view');
const TITLE = 'Conduit Web Fixture';
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title></head><body><h1>hello</h1></body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const FIXTURE = `http://127.0.0.1:${PORT}/`;

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // Open the command palette in command mode and run "Open web page…".
  await page.click('.omnibar');
  await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
  await page.fill('.palette__input', '>open web page');
  await page.waitForSelector('.palette__title', { timeout: 8000 });
  await page.keyboard.press('Enter');

  // The URL prompt modal → submit the fixture URL.
  await page.waitForSelector('.modal__input', { state: 'visible', timeout: 8000 });
  await page.fill('.modal__input', FIXTURE);
  await page.keyboard.press('Enter');

  // The <webview> mounts with the fixture src.
  await page.waitForSelector('.webview__frame', { state: 'attached', timeout: 10000 });
  const src = await page.getAttribute('.webview__frame', 'src');
  assert(src === FIXTURE, `webview src is the fixture URL (got ${src})`);
  log('PASS: <webview> mounted with fixture src ✓');

  // Back is disabled at the first page.
  const backDisabled = await page.getAttribute('.webview__btn[title="Back"]', 'disabled');
  assert(backDisabled !== null, 'Back button is disabled on the first page');
  log('PASS: Back disabled at first page ✓');

  // The page loads → title event → the active tab label becomes the page <title>.
  await page.waitForFunction(
    (t) => {
      const el = document.querySelector('.tab--active span');
      return el && el.textContent === t;
    },
    TITLE,
    { timeout: 15000 },
  );
  log('PASS: tab label adopted the live page title ✓');

  // Address-bar navigation to a dead port → in-tab error panel (not a blank frame).
  await page.fill('.webview__address', 'http://127.0.0.1:1/');
  await page.press('.webview__address', 'Enter');
  await page.waitForSelector('.webview__error', { state: 'visible', timeout: 15000 });
  log('PASS: failed load shows the in-tab error panel ✓');

  await launched.cleanup();
  server.close();
  log('PASS ✓ web-view: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.log(`[web-view] ${isAssertion ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}

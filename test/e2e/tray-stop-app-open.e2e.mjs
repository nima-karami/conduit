import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assert,
  finishScenario,
  launchApp,
  openSession,
  REPO,
  shutdownApp,
  tapBridge,
} from './harness.mjs';
import { injectStop, waitForMessage, waitUntil } from './tray-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[tray-stop-app-open] SKIP — suite is Windows-only');
  await finishScenario(0);
}

let launched;
let code = 0;
try {
  launched = await launchApp({ openFolder: false });
  const { page, userDataDir } = launched;
  await tapBridge(page);
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  const hello = await waitForMessage(userDataDir, 'in', (m) => m.type === 'hello');
  await waitForMessage(userDataDir, 'in', (m) => m.type === 'shown');
  await injectStop(userDataDir);
  await page.waitForFunction(
    (id) => (window.__sessions || []).some((s) => s.id === id && s.status === 'stale'),
    sid,
    { timeout: 30000 },
  );
  await waitUntil(
    async () =>
      (await page.evaluate(() => window.agentDeck.readLogTail(200))).tail.includes(
        'orderly end: no restart budget spent',
      ),
    'orderly restart budget log',
  );
  await waitForMessage(
    userDataDir,
    'in',
    (m) => m.type === 'hello' && m.pid !== hello.message.pid,
    30000,
    hello.next,
  );
  assert(
    !(await page.locator('body').innerText()).includes('stopped after'),
    'restart budget banner appeared',
  );
  const trayLog = await readFile(join(userDataDir, 'tray.log'), 'utf8');
  assert(/tray stopAll id=\d+ killed=1/.test(trayLog), 'tray stop was not recorded');
  console.log('[tray-stop-app-open] PASS');
} catch (error) {
  console.error('[tray-stop-app-open] FAIL', error);
  code = 1;
} finally {
  if (launched) await shutdownApp(launched.app, launched.page);
}
await finishScenario(code);

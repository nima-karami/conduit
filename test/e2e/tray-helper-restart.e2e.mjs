import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  finishScenario,
  launchApp,
  openSession,
  REPO,
  shutdownApp,
} from './harness.mjs';
import { waitForLine, waitForMessage } from './tray-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[tray-helper-restart] SKIP — suite is Windows-only');
  await finishScenario(0);
}

let first;
let second;
let scratch;
let code = 0;
try {
  const scratchRoot = join(process.env.TEMP, 'Codex-scratch');
  await mkdir(scratchRoot, { recursive: true });
  scratch = await mkdtemp(join(scratchRoot, 'tray-e2e-'));
  const changed = join(scratch, 'conduit-tray.exe');
  await copyFile(join(REPO, 'build', 'vendor', 'tray', 'conduit-tray.exe'), changed);
  await appendFile(changed, 'conduit tray e2e update');
  first = await launchApp({ openFolder: false });
  const { app, page, userDataDir } = first;
  await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  const hello = await waitForMessage(userDataDir, 'in', (m) => m.type === 'hello');
  await waitForMessage(userDataDir, 'in', (m) => m.type === 'shown', 30000, hello.next);
  const restartStarted = Date.now();
  process.kill(hello.message.pid);
  const replacement = await waitForMessage(
    userDataDir,
    'in',
    (m) => m.type === 'hello' && m.pid !== hello.message.pid,
    2000,
    hello.next,
  );
  await waitForMessage(
    userDataDir,
    'in',
    (m) => m.type === 'shown',
    Math.max(0, 2000 - (Date.now() - restartStarted)),
    replacement.next,
  );
  await closeApp(app, page);
  second = await launchApp({
    userDataDir,
    openFolder: false,
    env: { CONDUIT_E2E_APP_VERSION: '99.0.0', CONDUIT_TRAY_BINARY: changed },
  });
  const swap = await waitForLine(
    join(userDataDir, 'tray.log'),
    (line) => line.includes('tray helper swap: installed'),
    30000,
    1,
  );
  assert(
    swap.line.includes(join('runtime', 'tray', 'conduit-tray.exe')),
    `wrong stable path: ${swap.line}`,
  );
  const newHello = await waitForMessage(
    userDataDir,
    'in',
    (m) => m.type === 'hello' && m.pid !== replacement.message.pid,
    30000,
    replacement.next,
  );
  await waitForMessage(userDataDir, 'in', (m) => m.type === 'shown', 30000, newHello.next);
  console.log('[tray-helper-restart] PASS');
} catch (error) {
  console.error('[tray-helper-restart] FAIL', error);
  code = 1;
} finally {
  if (second) await shutdownApp(second.app, second.page);
  if (first) await shutdownApp(first.app, first.page);
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
await finishScenario(code);

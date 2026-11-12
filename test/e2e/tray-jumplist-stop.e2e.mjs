import { createRequire } from 'node:module';
import {
  assert,
  closeApp,
  finishScenario,
  hcTerminalOf,
  launchApp,
  launchElectron,
  openSession,
  REPO,
  shutdownApp,
  windowsOnlyScenario,
} from './harness.mjs';
import { sessionTerminalGone, waitForMessage, waitUntil } from './tray-helpers.mjs';

await windowsOnlyScenario('tray-jumplist-stop', 'Windows jump list and cmd.exe shell');

let launched;
let headless;
let code = 0;
try {
  launched = await launchApp({ openFolder: false });
  const { app, page, userDataDir } = launched;
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  await waitForMessage(userDataDir, 'in', (m) => m.type === 'shown');
  await closeApp(app, page);
  assert(hcTerminalOf(userDataDir, sid), 'agent did not survive app quit');
  const require = createRequire(import.meta.url);
  let windows = 0;
  headless = await launchElectron(
    {
      executablePath: require('electron'),
      args: [`--user-data-dir=${userDataDir}`, '.', '--stop-all-agents'],
      cwd: REPO,
      env: { ...process.env, CONDUIT_E2E: '1', CONDUIT_E2E_STOP_CONFIRM: 'accept' },
    },
    {
      headless: true,
      onWindow: () => {
        windows++;
      },
    },
  );
  const proc = headless.process();
  const exit = await new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve(proc.exitCode);
    else proc.once('exit', resolve);
  });
  assert(exit === 0, `headless stop exited ${exit}`);
  assert(windows === 0, `headless stop opened ${windows} windows`);
  await waitUntil(() => sessionTerminalGone(userDataDir, sid), 'session terminal exit');
  console.log('[tray-jumplist-stop] PASS');
} catch (error) {
  console.error('[tray-jumplist-stop] FAIL', error);
  code = 1;
} finally {
  if (headless) await shutdownApp(headless);
  if (launched) await shutdownApp(launched.app, launched.page);
}
await finishScenario(code);

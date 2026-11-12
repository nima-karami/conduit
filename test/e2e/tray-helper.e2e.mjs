import { join } from 'node:path';
import {
  assert,
  closeApp,
  finishScenario,
  hcTerminalOf,
  launchApp,
  openSession,
  ownHc,
  REPO,
  shutdownApp,
  windowsOnlyScenario,
} from './harness.mjs';
import {
  injectStop,
  isAlive,
  sessionTerminalGone,
  waitForLine,
  waitForMessage,
  waitUntil,
} from './tray-helpers.mjs';

await windowsOnlyScenario('tray-helper', 'Windows tray helper and cmd.exe shell');

let launched;
let code = 0;
try {
  launched = await launchApp({ openFolder: false });
  const { app, page, userDataDir } = launched;
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  const hello = await waitForMessage(userDataDir, 'in', (m) => m.type === 'hello');
  const pid = hello.message.pid;
  await waitForMessage(userDataDir, 'in', (m) => m.type === 'shown');
  await waitForMessage(
    userDataDir,
    'out',
    (m) =>
      m.type === 'view' &&
      m.view.tooltip.startsWith('Conduit') &&
      m.view.tooltip.endsWith(' — 1 agent running'),
  );
  assert(hcTerminalOf(userDataDir, sid), 'session terminal missing before quit');
  await closeApp(app, page);
  assert(hcTerminalOf(userDataDir, sid), 'session did not survive app quit');
  await injectStop(userDataDir);
  await waitForMessage(userDataDir, 'out', (m) => m.type === 'exit');
  await Promise.all([
    waitForMessage(userDataDir, 'in', (m) => m.type === 'hidden', 2000),
    waitUntil(() => !isAlive(pid), 'helper exit', 2000),
  ]);
  await waitForLine(join(userDataDir, 'tray.log'), (line) =>
    /tray stopAll id=\d+ killed=1/.test(line),
  );
  await waitUntil(() => sessionTerminalGone(userDataDir, sid), 'session terminal exit');
  await waitUntil(() => {
    const result = ownHc(userDataDir, ['ls', '--json', '--label', 'conduit.role=server']);
    if (result.status !== 0) return false;
    const parsed = result.json();
    return !(Array.isArray(parsed) ? parsed : (parsed.terminals ?? [])).some(
      (t) => t.state === 'live',
    );
  }, 'supervisor exit');
  console.log('[tray-helper] PASS');
} catch (error) {
  console.error('[tray-helper] FAIL', error);
  code = 1;
} finally {
  if (launched) await shutdownApp(launched.app, launched.page);
}
await finishScenario(code);

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
} from './harness.mjs';
import { injectStop, isAlive, waitForLine, waitForMessage, waitUntil } from './tray-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[tray-helper] SKIP — suite is Windows-only');
  await finishScenario(0);
}

/** Stop-all kills the last session and the idle core stops with it: an `hc ls` that lands mid-stop
 * reports `unavailable`, which means no terminal can be live. Any other failure still throws. */
function sessionTerminalGone(userDataDir, sessionId) {
  const r = ownHc(userDataDir, ['ls', '--json', '--label', `conduit.session=${sessionId}`]);
  if (r.status !== 0) {
    let kind;
    try {
      kind = JSON.parse(r.out).error?.kind;
    } catch {
      kind = undefined;
    }
    if (kind === 'unavailable') return true;
    throw new Error(`hc ls: exit ${r.status}: ${r.out.slice(0, 300)}`);
  }
  return !hcTerminalOf(userDataDir, sessionId);
}

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

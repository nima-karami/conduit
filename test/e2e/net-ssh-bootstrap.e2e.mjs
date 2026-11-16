import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c2Auth, c2AuthIfRunning } from './c2-auth.mjs';
import { C2 } from './c2-peer.mjs';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import { stopAllViaServer, teardownNames } from './harness-server-teardown.mjs';
import { linkView, startServer } from './net-helpers.mjs';

// A bootstraps a fresh remote B over fake-ssh: the push path (CONDUIT_E2E_NO_DOWNLOAD) lays out B's
// runtime, ensure starts B's server, and A links it. A second bootstrap attaches to it. B is then
// stopped with its own auth. The remote is this host, so this is the POSIX path only.
// Windows is skipped: fake-ssh runs the sh scripts through the local shell, and under cmd.exe they
// hit its 8191-character limit (remote-scripts.ts, measured). Pending a Windows box.

const log = makeLog('net-ssh-bootstrap');
const WAIT_MS = 60_000;
const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = [
  'CONDUIT_SSH_PATH',
  'CONDUIT_E2E_SSH_ARGS_PREFIX',
  'CONDUIT_E2E_NO_DOWNLOAD',
  'CONDUIT_NODE_BINARY',
  'XDG_CONFIG_HOME',
];

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

/** B answers C2 hello with its own secret: the server the bootstrap's ensure started is up. */
async function helloAnswers(endpoint, userData) {
  const auth = c2AuthIfRunning(userData);
  if (auth === undefined) return false;
  let c2;
  try {
    c2 = await C2.open(endpoint);
    await c2.call('hello', { appVersion: APP_VERSION, generation: 1, auth });
    return true;
  } catch {
    return false;
  } finally {
    c2?.close();
  }
}

async function run() {
  // The remote's userData is the probe's default: $XDG_CONFIG_HOME/conduit. Pointing it at a temp
  // dir keeps the desktop app's own config out of the scenario.
  const xdg = mkdtempSync(join(tmpdir(), 'bootstrap-xdg-'));
  const remoteUserData = join(xdg, 'conduit');
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let a;
  try {
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([FAKE_SSH]);
    // Forces the push path, and only under --e2e (services.ts). A's own node is the one pushed.
    process.env.CONDUIT_E2E_NO_DOWNLOAD = '1';
    process.env.CONDUIT_NODE_BINARY = process.execPath;
    process.env.XDG_CONFIG_HOME = xdg;
    a = await startServer('a');
    const remote = teardownNames(remoteUserData, process.platform, tmpdir());
    try {
      phase('1. a fresh remote: bootstrap installs, starts, and links');
      const first = await a.c2.call('link.sshBootstrap', { target: 'fake' });
      assert(first?.ok === true, `bootstrap: ${JSON.stringify(first)}`);
      assert(
        first.summary.installed === true && first.summary.reused === false,
        `first run summary: ${JSON.stringify(first.summary)}`,
      );
      const appDir = join(remoteUserData, 'runtime', APP_VERSION);
      assert(existsSync(join(appDir, 'node')), 'B has no node under runtime/<version>');
      assert(existsSync(join(appDir, 'server', 'main.js')), 'B has no server main.js');
      await eventually('B server answers hello with its secret', () =>
        helloAnswers(remote.serverEndpoint, remoteUserData),
      );
      await eventually('A up to B over ssh', async () => {
        const view = await linkView(a.c2, first.machineId);
        return view?.state === 'up' && view.transport === 'ssh';
      });

      phase('2. a second bootstrap attaches: nothing reinstalled');
      const second = await a.c2.call('link.sshBootstrap', { target: 'fake' });
      assert(second?.ok === true, `second bootstrap: ${JSON.stringify(second)}`);
      assert(
        second.summary.reused === true && second.summary.installed === false,
        `second run summary: ${JSON.stringify(second.summary)}`,
      );
      assert(second.machineId === first.machineId, 'second bootstrap linked a different machine');
    } finally {
      // Stopped with B's own auth, through its C2 stop-all, as the teardown of any server here.
      await stopAllViaServer({
        endpoint: remote.serverEndpoint,
        appVersion: APP_VERSION,
        auth: c2Auth(remoteUserData),
      });
    }
  } catch (error) {
    if (a) {
      const file = join(a.userData, 'server.log');
      if (existsSync(file)) log('a server.log tail:\n', readFileSync(file, 'utf8').slice(-8000));
    }
    throw error;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await a?.stop();
    rmSync(xdg, { recursive: true, force: true });
  }
}

if (process.platform === 'win32') {
  log('SKIP: the Windows remote path is pending a Windows box (remote-scripts.ts, cmd.exe limit)');
  await finishScenario(0);
} else {
  let code = 0;
  try {
    await run();
    log('PASS ✓');
  } catch (error) {
    code = error?.name === 'AssertionError' ? 1 : 2;
    log('FAIL ✗', error?.stack || error?.message || String(error));
  }
  await finishScenario(code);
}

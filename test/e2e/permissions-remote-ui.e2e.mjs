import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tapMcp, until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  finishScenario,
  launchApp,
  makeLog,
  phase,
  REPO,
  showRightView,
} from './harness.mjs';
import {
  agentRecords,
  ECHO_AGENT,
  linkView,
  networkState,
  startAgent,
  startServer,
} from './net-helpers.mjs';
import { assignProfileCas } from './permissions-policy-helpers.mjs';

const log = makeLog('permissions-remote-ui');
const fakeSsh = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const keys = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let a, b, launched;
const eventually = async (what, check) =>
  assert(await until(check, 30000), `timed out waiting for ${what}`);
const mcpOf = async (server) => (await server.c2.call('events.subscribe')).mcp ?? {};

try {
  process.env.CONDUIT_SSH_PATH = process.execPath;
  process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([fakeSsh]);
  a = await startServer('a', { electronProfile: true });
  b = await startServer('b');
  await Promise.all(
    [a, b].map((server) =>
      server.c2.call('serverSettings.patch', {
        patch: {
          networkBindHost: '127.0.0.1',
          networkPort: 0,
          networkSelfName: `net-${server.label}`,
        },
      }),
    ),
  );
  const added = await a.c2.call('link.sshAdd', {
    ssh: {
      target: 'fake',
      node: process.execPath,
      mainJs: join(REPO, 'out', 'server', 'main.js'),
      userData: b.userData,
    },
  });
  const aId = (await networkState(a)).machineId;
  const bId = (await networkState(b)).machineId;
  assert(added?.ok === true && added.machineId === bId, `link failed: ${JSON.stringify(added)}`);
  await eventually('own SSH link', async () => (await linkView(a.c2, bId))?.state === 'up');
  const caller = await startAgent(a);
  const local = await assignProfileCas(
    a.c2,
    { kind: 'session', sessionId: caller.sessionId },
    'lead',
    { claimSessions: true },
  );
  const peer = await assignProfileCas(b.c2, { kind: 'peer', machineId: aId }, 'worker');
  assert(local.reply?.result?.ok && peer.reply?.result?.ok, 'profile setup failed');
  launched = await launchApp({ userDataDir: a.userData, openFolder: false });
  const { page } = launched;
  await tapMcp(page);
  await showRightView(page, 'needs');
  phase('own remote permission rendered and answered on A');
  const before = agentRecords(a, caller.sessionId, 'RESULT').length;
  a.c2.notify('term.input', {
    sessionId: caller.sessionId,
    generation: caller.generation,
    data: `call open_session ${JSON.stringify({ machine: bId, agent: ECHO_AGENT, path: b.work, focus: false })}\r`,
  });
  let ask;
  await eventually('mirrored permission request on A', async () => {
    ask = (await mcpOf(a)).requests?.open.find(
      (r) => r.machine === bId && r.blocked === 'permission',
    );
    return !!ask;
  });
  const row = page.locator('.needs-list [role="option"]', { hasText: ask.title }).first();
  await row.waitFor({ timeout: 15000 });
  await row.click();
  const popup = page.locator('.reqtpl-popup .permissions-request-body');
  await popup.waitFor({ timeout: 10000 });
  assert(
    ask.remote?.machineName && (await popup.textContent()).includes(`On ${ask.remote.machineName}`),
    'remote machine not identified',
  );
  const evidence = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, '22-remote-answerable.png') });
  }
  await popup.getByRole('button', { name: 'Allow once', exact: true }).click();
  let result;
  await eventually('A agent receives B settlement', () => {
    result = agentRecords(a, caller.sessionId, 'RESULT')[before]?.result;
    return result !== undefined;
  });
  assert(
    typeof result?.session_id === 'string',
    `remote allow did not open a session: ${JSON.stringify(result)}`,
  );
  await eventually('B actually created the session', async () =>
    (await b.c2.call('events.subscribe')).sessions.some((s) => s.id === result.session_id),
  );
  await eventually(
    'A has no pending mirrored request',
    async () => !(await mcpOf(a)).requests?.open.some((r) => r.id === ask.id),
  );
  log('remote own ask answered on A; B created session and A cleared the mirror ✓');
  log('PASS ✓');
} catch (error) {
  log('FAIL ✗', error?.stack || error?.message || String(error));
  process.exitCode = error?.name === 'AssertionError' ? 1 : 2;
} finally {
  await launched?.cleanup();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all([a?.stop(), b?.stop()]);
}
await finishScenario(process.exitCode ?? 0);

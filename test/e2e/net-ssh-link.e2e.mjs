import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C2 } from './c2-peer.mjs';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import {
  callTool,
  linkView,
  networkState,
  readAudit,
  startAgent,
  startServerPair,
} from './net-helpers.mjs';

// A link over an ssh stdio child, end to end: A dials B through fake-ssh, which runs B's real
// `main.js --link-stdio` bridge. The bridge is killed mid-run; a message queued while it was down
// must arrive exactly once after the redial. A bridge without the secret, and C2 without auth,
// are refused. See docs/plans/2026-11-16-remote-ssh-stdio-link.plan.md Task 3.3.

const log = makeLog('net-ssh-link');
const WAIT_MS = 30_000;
const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const BRIDGE_MAIN = join(REPO, 'out', 'server', 'main.js');
const PID_LINE = /^fake-ssh: pid (\d+)$/gm;

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

function records(server) {
  const file = join(server.userData, 'conduit-mcp', 'messages.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The 4-byte big-endian length prefix and JSON body of one link frame, as the bridge sends it. */
function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/**
 * The stand-in for sshd's remote command: a launcher that runs fake-ssh and sends its stderr to a
 * file, so the scenario can read each child's pid ("fake-ssh: pid <n>") and kill it by that pid.
 * A POSIX shell script: Windows cannot exec a .cjs, so this scenario does not run there yet.
 */
function sshLauncher(dir) {
  const stderrFile = join(dir, 'ssh-stderr.log');
  const launcher = join(dir, 'ssh');
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec '${process.execPath}' '${FAKE_SSH}' "$@" 2>>'${stderrFile}'\n`,
  );
  chmodSync(launcher, 0o755);
  return { launcher, stderrFile };
}

function pidsOf(stderrFile) {
  if (!existsSync(stderrFile)) return [];
  return [...readFileSync(stderrFile, 'utf8').matchAll(PID_LINE)].map((m) => Number(m[1]));
}

async function run() {
  assert(
    process.platform !== 'win32',
    'net-ssh-link needs a Windows ssh launcher (a .cjs cannot be exec-ed there); see the fork in the plan report',
  );
  const sshDir = mkdtempSync(join(tmpdir(), 'ssh-link-'));
  let pair;
  const previousSsh = process.env.CONDUIT_SSH_PATH;
  try {
    const { launcher, stderrFile } = sshLauncher(sshDir);
    // Both servers inherit the launcher; only A dials, so B's value is never used.
    process.env.CONDUIT_SSH_PATH = launcher;
    pair = await startServerPair();
    const { a, b } = pair;

    phase('1. link.sshAdd dials B over fake-ssh and both sides show transport ssh');
    const result = await a.c2.call('link.sshAdd', {
      ssh: {
        target: 'fake',
        node: process.execPath,
        mainJs: BRIDGE_MAIN,
        userData: b.userData,
      },
    });
    const bId = (await networkState(b)).machineId;
    assert(
      result?.ok === true && result.machineId === bId,
      `link.sshAdd: ${JSON.stringify(result)}`,
    );
    const aId = (await networkState(a)).machineId;
    await eventually('A up to B over ssh', async () => {
      const view = await linkView(a.c2, bId);
      return view?.state === 'up' && view.transport === 'ssh';
    });
    await eventually('B up to A over ssh', async () => {
      const view = await linkView(b.c2, aId);
      return view?.state === 'up' && view.transport === 'ssh';
    });

    phase('2. an agent on A sends to an agent on B over the ssh link');
    const aa = await startAgent(a);
    const ba = await startAgent(b);
    let address;
    await eventually('B agent in A directory', async () => {
      const listed = await callTool(a, aa, 'list_sessions', {});
      address = listed.sessions?.find(
        (s) => s.session_id === ba.sessionId && s.address?.endsWith(`@${bId}`),
      )?.address;
      return address !== undefined;
    });
    const first = await callTool(a, aa, 'send_message', { to: [address], body: 'over ssh' });
    assert(first.recipients?.[0]?.status === 'queued', `first send: ${JSON.stringify(first)}`);
    await eventually('B receives the first message', () =>
      records(b).some((r) => r.t === 'msg' && r.msg.originMessageId === first.message_id),
    );

    phase('3. kill the bridge; a message sent while down arrives exactly once after redial');
    const [bridgePid] = pidsOf(stderrFile).slice(-1);
    assert(bridgePid !== undefined, 'no fake-ssh pid recorded for the first bridge');
    // The pid is the bridge's own, read from the stand-in's stderr this scenario started.
    process.kill(bridgePid, 'SIGKILL');
    await eventually('A link down after the bridge died', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    const queued = await callTool(a, aa, 'send_message', { to: [address], body: 'while down' });
    assert(queued.recipients?.[0]?.status === 'queued', `queued send: ${JSON.stringify(queued)}`);
    await eventually('A link redialed with a new bridge', async () => {
      const pids = pidsOf(stderrFile);
      const view = await linkView(a.c2, bId);
      return view?.state === 'up' && pids.length >= 2 && pids.at(-1) !== bridgePid;
    });
    await eventually('B receives the queued message once', () =>
      records(b).some((r) => r.t === 'msg' && r.msg.originMessageId === queued.message_id),
    );
    const copies = records(b).filter(
      (r) => r.t === 'msg' && r.msg.originMessageId === queued.message_id,
    ).length;
    assert(copies === 1, `queued message delivered ${copies} times, want exactly once`);

    phase('4. a bridge with the wrong secret is refused and audited');
    const bridgeSocket = await new Promise((resolve, reject) => {
      const sock = net.createConnection(b.names.linkEndpoint, () => resolve(sock));
      sock.once('error', reject);
    });
    const closed = new Promise((resolve) => bridgeSocket.once('close', resolve));
    bridgeSocket.write(frame({ t: 'bridge', v: 1, secret: 'not-the-secret' }));
    await closed;
    assert(
      readAudit(b.userData).some(
        (e) => e.kind === 'bridge.refused' && e.detail?.reason === 'bad_secret',
      ),
      'B audit has no bridge.refused bad_secret line',
    );

    phase('5. C2 without auth is refused after hello');
    const raw = await C2.open(b.names.serverEndpoint);
    try {
      await raw.call('hello', { appVersion: APP_VERSION, generation: 1 });
      let refusal = null;
      try {
        await raw.call('events.subscribe');
      } catch (error) {
        refusal = error;
      }
      assert(
        refusal !== null && /auth required/.test(refusal.message),
        `unauthed events.subscribe: ${refusal?.message ?? 'not refused'}`,
      );
    } finally {
      raw.close();
    }
  } catch (error) {
    if (pair) for (const server of [pair.a, pair.b]) dumpServerLog(server);
    throw error;
  } finally {
    if (previousSsh === undefined) delete process.env.CONDUIT_SSH_PATH;
    else process.env.CONDUIT_SSH_PATH = previousSsh;
    await pair?.stopAll();
    rmSync(sshDir, { recursive: true, force: true });
  }
}

function dumpServerLog(server) {
  const file = join(server.userData, 'server.log');
  if (existsSync(file))
    log(`${server.label} server.log tail:\n`, readFileSync(file, 'utf8').slice(-8000));
}

let code = 0;
try {
  await run();
  log('PASS ✓');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL ✗', error?.stack || error?.message || String(error));
}
await finishScenario(code);

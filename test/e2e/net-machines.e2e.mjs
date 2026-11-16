import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import { callTool, linkView, networkState, startAgent, startServerPair } from './net-helpers.mjs';

// The machine tools over one ssh link, on fake-ssh: A adds B, then an agent on A lists, connects,
// disconnects and reconnects B, with B's own session still running. The owner's needs-person pane
// is opened over C2. Nothing here bootstraps: B's machine block comes from its hello. See
// docs/plans/2026-11-16-remote-ssh-machines.plan.md Slice 3.

const log = makeLog('net-machines');
const WAIT_MS = 30_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
// The reserved agent id a command session carries (src/session-command.ts COMMAND_AGENT_ID).
const PANE_AGENT_ID = 'conduit:command';

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

/**
 * Gives one agent session the Lead profile through CON-24's assignment message, as the renderer
 * sends it (mcp.fromRenderer tunnels it to the host). Lead is what allows connect and disconnect.
 */
async function assignLead(server, sessionId) {
  const r = await server.c2.call('mcp.fromRenderer', {
    windowId: 1,
    message: {
      type: 'mcp:setAssignment',
      requestId: 1,
      point: { kind: 'session', sessionId },
      profileId: 'lead',
    },
  });
  assert(r.reply?.ok === true, `setAssignment lead on ${server.label}: ${JSON.stringify(r)}`);
}

async function run() {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let pair;
  try {
    // Both servers inherit this; only A dials, so B never reads the stand-in settings.
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([FAKE_SSH]);
    pair = await startServerPair();
    const { a, b } = pair;

    phase('1. A adds B over fake-ssh; B has a machine block from its hello');
    const added = await a.c2.call('link.sshAdd', {
      ssh: {
        target: 'fake',
        node: process.execPath,
        mainJs: join(REPO, 'out', 'server', 'main.js'),
        userData: b.userData,
      },
    });
    const bId = (await networkState(b)).machineId;
    assert(added?.ok === true && added.machineId === bId, `link.sshAdd: ${JSON.stringify(added)}`);
    await eventually('A up to B over ssh', async () => {
      const view = await linkView(a.c2, bId);
      return view?.state === 'up' && view.transport === 'ssh';
    });

    phase('2. an agent on A with Lead lists, connects, disconnects and reconnects B');
    const aa = await startAgent(a);
    const ba = await startAgent(b);
    await assignLead(a, aa.sessionId);

    const listed = await callTool(a, aa, 'list_machines', {});
    const row = Array.isArray(listed?.machines)
      ? listed.machines.find((m) => m.machine_id === bId)
      : undefined;
    assert(row?.state === 'up', `list_machines: ${JSON.stringify(listed)}`);

    const reused = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(
      reused.reused === true && reused.machine_id === bId && reused.state === 'up',
      `connect_machine (up): ${JSON.stringify(reused)}`,
    );

    const down = await callTool(a, aa, 'disconnect_machine', { machine: bId });
    assert(down.state === 'down' && down.machine === 'fake', `disconnect: ${JSON.stringify(down)}`);
    await eventually('A link to B is no longer up', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    // The remote session is B's own: disconnecting A's link must not stop it. A call answered by
    // B's agent after the disconnect is the proof it is still running.
    const stillRunning = await callTool(b, ba, 'list_sessions', {});
    assert(
      stillRunning.sessions?.some((s) => s.session_id === ba.sessionId && s.self === true),
      `B's session after disconnect: ${JSON.stringify(stillRunning)}`,
    );

    const again = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(
      again.state === 'up' && again.machine_id === bId && again.reused === false,
      `reconnect: ${JSON.stringify(again)}`,
    );

    // A value that is not an ssh target, so no bootstrap or forced ask: only the name lookup
    // answers, and it finds nothing.
    const unknown = await callTool(a, aa, 'connect_machine', { machine: 'no such machine' });
    assert(
      unknown?.error?.code === 'machine_unknown',
      `unknown machine: ${JSON.stringify(unknown)}`,
    );

    phase('3. the owner opens the needs-person pane over C2; it returns a session, then closes it');
    const pane = await a.c2.call('machines.openNeedsPerson', { target: 'fake' });
    assert(
      typeof pane?.sessionId === 'string' && pane.sessionId.length > 0,
      `openNeedsPerson: ${JSON.stringify(pane)}`,
    );
    // The pane is a command session: its agent id is the reserved one (src/session-command.ts) and
    // its program is the ssh path, with the master's options. The stand-in gets no remote command,
    // so the pane ends at once; closing it only drops the session the pane left behind.
    const snapshot = await a.c2.call('events.subscribe');
    const paneRow = snapshot.sessions.find((x) => x.id === pane.sessionId);
    assert(paneRow?.agentId === PANE_AGENT_ID, `pane agent: ${JSON.stringify(paneRow)}`);
    assert(
      paneRow.command?.command === process.env.CONDUIT_SSH_PATH &&
        paneRow.command.args.includes('ControlMaster=yes'),
      `pane command: ${JSON.stringify(paneRow.command)}`,
    );
    await a.c2.call('sessions.remove', { sessionId: pane.sessionId });
  } catch (error) {
    if (pair) for (const server of [pair.a, pair.b]) dumpServerLog(server);
    throw error;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await pair?.stopAll();
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

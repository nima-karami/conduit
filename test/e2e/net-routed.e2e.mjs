import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ID, until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import {
  agentRecords,
  callTool,
  ECHO_AGENT,
  linkView,
  networkState,
  startAgent,
  startServerPair,
} from './net-helpers.mjs';
import { assignProfileCas } from './permissions-policy-helpers.mjs';

// The six session tools across one ssh link, on fake-ssh: an agent on A with Lead lists B's agents,
// opens a session on B, reads and types into it by its handle@machine address, sees it as its own
// in list_sessions, and closes it. Then the bridge is killed during a routed call: the call ends as
// peer_unreachable, and B ran it at most once. See docs/plans/2026-11-16-remote-ssh-routed-tools.plan.md
// Slice 3. Nothing here bootstraps: B's machine block comes from its hello.

const log = makeLog('net-routed');
const WAIT_MS = 30_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const PID_LINE = /^fake-ssh: pid (\d+)$/gm;
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX', 'FAKE_SSH_STDERR_LOG'];

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

/** The pids of every fake-ssh child this run started; the stand-in appends one line per child. */
function pidsOf(pidLog) {
  if (!existsSync(pidLog)) return [];
  return [...readFileSync(pidLog, 'utf8').matchAll(PID_LINE)].map((m) => Number(m[1]));
}

/** The generation B reports for a session: term.input is refused for any other generation. */
async function generationOf(server, sessionId) {
  let generation;
  await eventually(`B reports a generation for ${sessionId}`, () => {
    const latest = server.c2.events.filter((e) => e.type === 'sessions.changed').at(-1);
    generation = latest?.data.sessions.find((s) => s.id === sessionId)?.runtime?.generation;
    return typeof generation === 'number';
  });
  return generation;
}

/** Gives one agent session the Lead profile through CON-24's assignment message, as the renderer sends it. */
async function assignLead(server, sessionId) {
  const r = await assignProfileCas(server.c2, { kind: 'session', sessionId }, 'lead', {
    claimSessions: true,
  });
  assert(r.reply?.result?.ok === true, `assign lead on ${server.label}: ${JSON.stringify(r)}`);
}

/** How many of B's log lines say it started serving a call of this tool (the line is written before the effect). */
function servingLines(server, tool) {
  const file = join(server.userData, 'server.log');
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes('routed call serving') && line.includes(`"tool":"${tool}"`))
    .length;
}

/** A pause in real time, for a race the test has no signal for. */
const beat = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Types a tool call into an agent without waiting for its answer; returns how many answers existed. */
function typeCall(server, agent, tool, args) {
  const before = agentRecords(server, agent.sessionId, 'RESULT').length;
  server.c2.notify('term.input', {
    sessionId: agent.sessionId,
    generation: agent.generation,
    data: `call ${tool} ${JSON.stringify(args)}\r`,
  });
  return before;
}

async function run() {
  const sshDir = mkdtempSync(join(tmpdir(), 'routed-ssh-'));
  const pidLog = join(sshDir, 'fake-ssh-pids.log');
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let pair;
  try {
    // Both servers inherit this; only A dials, so B never reads the stand-in settings.
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([FAKE_SSH]);
    process.env.FAKE_SSH_STDERR_LOG = pidLog;
    pair = await startServerPair();
    const { a, b } = pair;

    phase('1. A adds B over fake-ssh; the link is up and ssh on A');
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

    const aa = await startAgent(a);
    const ba = await startAgent(b);
    await assignLead(a, aa.sessionId);
    const me = (await callTool(a, aa, 'list_sessions', {})).sessions?.find(
      (s) => s.self === true,
    )?.handle;
    assert(typeof me === 'string', 'the A agent has no handle in list_sessions');

    phase('2. the A agent lists the agents on B');
    const listed = await callTool(a, aa, 'list_agents', { machine: bId });
    assert(
      Array.isArray(listed?.agents) && listed.agents.some((x) => x.id === ECHO_AGENT),
      `list_agents on ${bId}: ${JSON.stringify(listed)}`,
    );

    phase('3. open_session on B returns a handle@machine address');
    const opened = await callTool(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    assert(
      typeof opened?.session_id === 'string' &&
        typeof opened.handle === 'string' &&
        opened.handle.includes('@'),
      `open_session on ${bId}: ${JSON.stringify(opened)}`,
    );
    const address = opened.handle;
    const remoteId = opened.session_id;

    phase("3b. a message with open_session is stored on B from A's lead, framed as the lead");
    // The echo probe has no MCP client, so the message is read by the fake MCP agent.
    const aId = (await networkState(a)).machineId;
    const withMessage = await callTool(a, aa, 'open_session', {
      machine: bId,
      agent: FAKE_AGENT_ID,
      path: b.work,
      focus: false,
      message: 'hello from A',
    });
    assert(
      typeof withMessage?.session_id === 'string' && typeof withMessage.message?.id === 'string',
      `open_session with a message: ${JSON.stringify(withMessage)}`,
    );
    const fresh = {
      sessionId: withMessage.session_id,
      generation: await generationOf(b, withMessage.session_id),
    };
    await eventually('the fake agent on B is READY', () =>
      agentRecords(b, fresh.sessionId, 'READY').some((r) => r.tools.includes('read_inbox')),
    );
    const inbox = await callTool(b, fresh, 'read_inbox', {});
    const first = inbox.messages?.find((m) => m.message_id === withMessage.message.id);
    assert(
      first?.from === `${me}@${aId}` &&
        first.body.includes('your lead') &&
        first.body.includes('hello from A'),
      `read_inbox on the new session: ${JSON.stringify(inbox)}`,
    );

    phase('4. read_screen by that address returns rows');
    const screen = await callTool(a, aa, 'read_screen', { session: address });
    assert(
      Array.isArray(screen?.rows) && screen.session === address,
      `read_screen ${address}: ${JSON.stringify(screen)}`,
    );

    phase('5. send_input by that address types into the session');
    const typed = await callTool(a, aa, 'send_input', { session: address, text: 'hi' });
    assert(
      typed?.sent_chars === 2 && typed.session === address,
      `send_input: ${JSON.stringify(typed)}`,
    );

    phase("6. A lists B's session as its own lead's opening");
    // list_sessions is a snapshot from B's monitor, so the row can trail the open by a moment.
    assert(
      await until(async () => {
        const rows = await callTool(a, aa, 'list_sessions', {});
        return rows.sessions?.some((s) => s.session_id === remoteId && s.opened_by === me) === true;
      }, 15_000),
      `list_sessions never showed ${address} opened by ${me}`,
    );

    phase('7. close_session by that address closes it on B');
    const closed = await callTool(a, aa, 'close_session', { session: address });
    // close_session reports B's session id, which routing passes through (plan decision 5).
    assert(closed?.closed === remoteId, `close_session ${address}: ${JSON.stringify(closed)}`);
    await eventually('the session is gone from B', async () => {
      const listedOnB = await callTool(b, ba, 'list_sessions', {});
      return !listedOnB.sessions?.some((s) => s.session_id === remoteId);
    });

    phase(
      '8. the bridge is killed while B is serving a routed open: the drop, or the open, once on B',
    );
    const countBefore = (await callTool(b, ba, 'list_sessions', {})).sessions?.length ?? -1;
    const [bridgePid] = pidsOf(pidLog).slice(-1);
    assert(bridgePid !== undefined, 'no fake-ssh pid recorded for the bridge');
    const servingBefore = servingLines(b, 'open_session');
    const answersBefore = typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    // Kill only once B's own log says it is serving the open. B keeps running after its bridge dies,
    // so the open runs exactly once on B either way; only the answer can be lost.
    await eventually(
      'B is serving the open',
      () => servingLines(b, 'open_session') > servingBefore,
    );
    // The pid is the bridge's own, read from the stand-in's stderr this scenario started.
    process.kill(bridgePid, 'SIGKILL');
    await eventually(
      'the routed open is answered',
      () => agentRecords(a, aa.sessionId, 'RESULT').length > answersBefore,
    );
    const answer = agentRecords(a, aa.sessionId, 'RESULT').at(-1)?.result;
    await eventually('A redials B with a new bridge', async () => {
      const pids = pidsOf(pidLog);
      const view = await linkView(a.c2, bId);
      return view?.state === 'up' && pids.length >= 2 && pids.at(-1) !== bridgePid;
    });
    await beat(2000);
    const countAfter = (await callTool(b, ba, 'list_sessions', {})).sessions?.length ?? -1;
    const delta = countAfter - countBefore;
    assert(delta === 1, `B must run the open exactly once: ${countBefore} -> ${countAfter}`);
    if (answer?.error !== undefined) {
      // The answer was lost with the bridge: the error is the drop, not a "not connected" pre-check.
      assert(
        answer.error.code === 'peer_unreachable' && /dropped/.test(answer.error.message),
        `open_session across a dead bridge: ${JSON.stringify(answer)}`,
      );
    } else {
      assert(
        typeof answer?.session_id === 'string',
        `open_session completed: ${JSON.stringify(answer)}`,
      );
    }
  } catch (error) {
    if (pair) for (const server of [pair.a, pair.b]) dumpServerLog(server);
    throw error;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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

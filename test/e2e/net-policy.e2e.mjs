import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import {
  callTool,
  ECHO_AGENT,
  linkView,
  networkState,
  startAgent,
  startServerPair,
} from './net-helpers.mjs';

// Remote rules over one ssh link, on fake-ssh (CON-46 L5; plan
// docs/plans/2026-11-16-remote-ssh-rules.plan.md, slice L5 steps 1-4):
//   1. A sets B's default point to observer; A applies it, B's rev is +1 and B's default is observer.
//   2. The link is down: A's edit to worker waits as a draft; the link comes back; A pushes it.
//   3. The link is down: A's edit to lead is a draft; B changes its own default; the link comes back:
//      A shows conflict and B keeps its copy; A re-applies on top and B has lead.
//   4. A peer grant made on B shows on A, and A's revoke removes it on B.
// B's rules are read from its own policy.json (rev, default assignment); B's grants from its C2
// state. Links go down and up with disconnect_machine / connect_machine, as net-requests does.

const log = makeLog('net-policy');
const WAIT_MS = 30_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

/** The mcp UI state of one server, as its C2 snapshot shows it. */
async function mcpOf(server) {
  const snapshot = await server.c2.call('events.subscribe');
  return snapshot.mcp ?? {};
}

/** This machine's row in A's policy.machines (its mirror, status, and grants), or null. */
async function machineRow(server, machineId) {
  const mcp = await mcpOf(server);
  return mcp.policy?.machines?.find((m) => m.machineId === machineId) ?? null;
}

/** B's own policy.json: its rev and assignments. */
function policyFileOf(server) {
  const file = join(server.userData, 'conduit-mcp', 'policy.json');
  assert(existsSync(file), `no policy.json on ${server.label}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The profile on B's default point, or null when it has none. */
function defaultProfileOf(server) {
  const entry = policyFileOf(server).assignments.find((a) => a.point.kind === 'default');
  return entry?.assignment.profileId ?? null;
}

/** Sends one renderer message to a server's MCP host and returns the reply envelope. */
function fromRenderer(server, message) {
  return server.c2.call('mcp.fromRenderer', { windowId: 1, message });
}

/** Gives one agent session a policy profile through CON-24's assignment message, as the renderer sends it. */
async function assignProfile(server, sessionId, profileId) {
  const r = await fromRenderer(server, {
    type: 'mcp:setAssignment',
    requestId: 1,
    point: { kind: 'session', sessionId },
    profileId,
  });
  assert(
    r.reply?.ok === true,
    `setAssignment ${profileId} on ${server.label}: ${JSON.stringify(r)}`,
  );
}

/** Edits the default point's profile on a server; `machine` makes it an edit of that remote machine. */
async function setDefault(server, profileId, machine) {
  const r = await fromRenderer(server, {
    type: 'mcp:setAssignment',
    requestId: 1,
    point: { kind: 'default' },
    profileId,
    ...(machine === undefined ? {} : { machine }),
  });
  assert(
    r.reply?.ok === true,
    `setAssignment default ${profileId} on ${server.label}: ${JSON.stringify(r)}`,
  );
}

/** Answers a request through the renderer message path, as a window does; resolves its result. */
async function answer(server, requestId, body) {
  const r = await fromRenderer(server, { type: 'mcp:requestAnswer', requestId, answer: body });
  assert(
    r.reply?.result !== undefined,
    `mcp:requestAnswer on ${server.label}: ${JSON.stringify(r)}`,
  );
  return r.reply.result;
}

/** The open permission ask from a machine, as A shows it, or null. */
async function permissionRow(server, machineId) {
  const mcp = await mcpOf(server);
  const rows = mcp.requests?.open ?? [];
  return rows.find((r) => r.machine === machineId && r.blocked === 'permission') ?? null;
}

/** Types a tool call into an agent without waiting for its answer. */
function typeCall(server, agent, tool, args) {
  server.c2.notify('term.input', {
    sessionId: agent.sessionId,
    generation: agent.generation,
    data: `call ${tool} ${JSON.stringify(args)}\r`,
  });
}

async function run() {
  const sshDir = mkdtempSync(join(tmpdir(), 'policy-ssh-'));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let pair;
  try {
    // Both servers inherit this; only A dials, so B never reads the stand-in settings.
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([FAKE_SSH]);
    pair = await startServerPair();
    const { a, b } = pair;

    phase('0. A adds B over fake-ssh; the link is up and A has its Lead agent');
    const added = await a.c2.call('link.sshAdd', {
      ssh: {
        target: 'fake',
        node: process.execPath,
        mainJs: join(REPO, 'out', 'server', 'main.js'),
        userData: b.userData,
      },
    });
    const bId = (await networkState(b)).machineId;
    const aId = (await networkState(a)).machineId;
    assert(added?.ok === true && added.machineId === bId, `link.sshAdd: ${JSON.stringify(added)}`);
    await eventually('A up to B over ssh', async () => {
      const view = await linkView(a.c2, bId);
      return view?.state === 'up' && view.transport === 'ssh';
    });
    const aa = await startAgent(a);
    await assignProfile(a, aa.sessionId, 'lead');

    phase('1. A sets B default to observer; A shows it applied; B has rev+1 and observer');
    let row;
    await eventually("A mirrors B's rules as applied", async () => {
      row = await machineRow(a, bId);
      return row?.status === 'applied' && typeof row.rev === 'number';
    });
    const r0 = row.rev;
    await setDefault(a, 'observer', bId);
    await eventually('A shows the edit applied on B at r0+1', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'applied' && row.rev === r0 + 1;
    });
    // B's policy.json write is coalesced, so the disk copy can trail the snapshot A already has.
    await eventually('B stores the push at r0+1', async () => {
      return policyFileOf(b).rev === r0 + 1 && defaultProfileOf(b) === 'observer';
    });

    phase('2. the link is down: A edits to worker and waits; the link returns; A pushes');
    const down1 = await callTool(a, aa, 'disconnect_machine', { machine: bId });
    assert(down1.state === 'down', `disconnect_machine: ${JSON.stringify(down1)}`);
    await eventually('A no longer has B up', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    await setDefault(a, 'worker', bId);
    await eventually('A shows the edit waiting for B', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'waiting';
    });
    assert(defaultProfileOf(b) === 'observer', `B changed while down: ${defaultProfileOf(b)}`);
    const up2 = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(up2.state === 'up', `connect_machine: ${JSON.stringify(up2)}`);
    await eventually('A pushes the draft; B has worker at r0+2', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'applied' && row.rev === r0 + 2 && defaultProfileOf(b) === 'worker';
    });

    phase(
      "3. B edits its own default while A's edit to lead waits; A shows conflict; A re-applies",
    );
    const down3 = await callTool(a, aa, 'disconnect_machine', { machine: bId });
    assert(down3.state === 'down', `disconnect_machine: ${JSON.stringify(down3)}`);
    await eventually('A no longer has B up again', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    await setDefault(a, 'lead', bId);
    await eventually('A shows the lead edit waiting', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'waiting';
    });
    await setDefault(b, 'observer');
    await eventually("B's own edit lands at r0+3", async () => {
      return policyFileOf(b).rev === r0 + 3 && defaultProfileOf(b) === 'observer';
    });
    const up3 = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(up3.state === 'up', `connect_machine: ${JSON.stringify(up3)}`);
    await eventually('A shows conflict with B rev r0+3', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'conflict' && row.conflict !== null;
    });
    assert(
      defaultProfileOf(b) === 'observer' && policyFileOf(b).rev === r0 + 3,
      'a conflict must not push: B kept its own copy',
    );
    const reapply = await fromRenderer(a, {
      type: 'mcp:remotePolicy',
      machine: bId,
      action: 'reapply',
    });
    assert(
      reapply.reply === undefined,
      `mcp:remotePolicy has no reply: ${JSON.stringify(reapply)}`,
    );
    await eventually('A re-applies on top; B has lead at r0+4', async () => {
      row = await machineRow(a, bId);
      return (
        row?.status === 'applied' &&
        defaultProfileOf(b) === 'lead' &&
        policyFileOf(b).rev === r0 + 4
      );
    });

    phase('4. a peer grant made on B shows on A; A revokes it and it is gone on B');
    const grantPeer = await fromRenderer(b, {
      type: 'mcp:setAssignment',
      requestId: 1,
      point: { kind: 'peer', machineId: aId },
      profileId: 'worker',
    });
    assert(grantPeer.reply?.ok === true, `peer assignment on B: ${JSON.stringify(grantPeer)}`);
    typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    let ask = null;
    await eventually("A shows B's permission ask", async () => {
      ask = await permissionRow(a, bId);
      return ask !== null;
    });
    const granted = await answer(a, ask.id, {
      outcome: 'allowed',
      grant: { who: 'peer', on: 'anywhere', for: 'until-revoked' },
    });
    assert(granted.ok === true, `the grant answer was refused: ${JSON.stringify(granted)}`);
    let grant = null;
    await eventually("A's mirror of B shows the grant", async () => {
      row = await machineRow(a, bId);
      grant = row?.grants.find((g) => g.tool === 'open_session') ?? null;
      return grant !== null;
    });
    const onB = (await mcpOf(b)).policy?.grants ?? [];
    assert(
      onB.some((g) => g.id === grant.id),
      `B does not hold the grant A shows: ${JSON.stringify(onB)}`,
    );
    const revoked = await fromRenderer(a, {
      type: 'mcp:revokeGrant',
      requestId: 1,
      grantId: grant.id,
      machine: bId,
    });
    assert(revoked.reply?.ok === true, `revoke from A: ${JSON.stringify(revoked)}`);
    await eventually('the grant is gone from A and from B', async () => {
      row = await machineRow(a, bId);
      const stillOnB = ((await mcpOf(b)).policy?.grants ?? []).some((g) => g.id === grant.id);
      return !row.grants.some((g) => g.id === grant.id) && !stillOnB;
    });
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

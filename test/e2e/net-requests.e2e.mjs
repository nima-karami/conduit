import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
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

// Request mirrors and remote answers over one ssh link, on fake-ssh (CON-42 L5b; plan
// docs/plans/2026-11-16-remote-ssh-requests.plan.md, slice L5 steps 1-4):
//   (a) a B agent's confirm shows on A tagged with B's machine; A's answer reaches the agent.
//   (b) B assigns A Worker; a routed open_session from A asks on B, A allows, the call completes.
//   (c) A denies the same kind of ask; the routed call is denied.
//   (d) an answer while the link is down is refused on A as peer_unreachable.
// (a), (b) and (c) need the answer path on B (McpNetworkPort.applyRemoteAnswer, L5a); (b) and (c)
// also need the remote ask to be a real wait (L5a replaces remote_ask). (d) is refused on A alone.
// Nothing here bootstraps: B's machine block comes from its hello.

const log = makeLog('net-requests');
const WAIT_MS = 30_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
const CONFIRM_TITLE = 'Ship the build?';

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

/** The open requests of one server, as its C2 snapshot shows them (the mcp UI state). */
async function openRequests(server) {
  const snapshot = await server.c2.call('events.subscribe');
  return snapshot.mcp?.requests?.open ?? [];
}

/** The open confirm that B's agent asked, as A shows it, or null. */
async function confirmRow(server, machineId) {
  const rows = await openRequests(server);
  return rows.find((r) => r.machine === machineId && r.title === CONFIRM_TITLE) ?? null;
}

/** The open permission ask from B, as A shows it, or null. */
async function permissionRow(server, machineId) {
  const rows = await openRequests(server);
  return rows.find((r) => r.machine === machineId && r.blocked === 'permission') ?? null;
}

/** Gives one agent session a policy profile through CON-24's assignment message, as the renderer sends it. */
async function assignProfile(server, sessionId, profileId) {
  const r = await assignProfileCas(server.c2, { kind: 'session', sessionId }, profileId, {
    claimSessions: true,
  });
  assert(
    r.reply?.result?.ok === true,
    `assign ${profileId} on ${server.label}: ${JSON.stringify(r)}`,
  );
}

/**
 * B's assignment for a remote principal: what A's calls may do on B. The point is the peer, not a
 * session, so it applies to every call A's agents route to B.
 */
async function assignPeer(server, machineId, profileId) {
  const r = await assignProfileCas(server.c2, { kind: 'peer', machineId }, profileId);
  assert(r.reply?.result?.ok === true, `assign peer on ${server.label}: ${JSON.stringify(r)}`);
}

/** Answers a request through the renderer message path, as a window does; resolves its result. */
async function answer(server, requestId, body) {
  const r = await server.c2.call('mcp.fromRenderer', {
    windowId: 1,
    message: { type: 'mcp:requestAnswer', requestId, answer: body },
  });
  assert(
    r.reply?.result !== undefined,
    `mcp:requestAnswer on ${server.label}: ${JSON.stringify(r)}`,
  );
  return r.reply.result;
}

/** Types a tool call into an agent without waiting for its answer. */
function typeCall(server, agent, tool, args) {
  server.c2.notify('term.input', {
    sessionId: agent.sessionId,
    generation: agent.generation,
    data: `call ${tool} ${JSON.stringify(args)}\r`,
  });
}

/** The results an agent has received so far. */
const resultsOf = (server, agent) => agentRecords(server, agent.sessionId, 'RESULT');

/** How many of B's log lines say it started serving a call of this tool (the line is written before the effect). */
function dumpServerLog(server) {
  const file = join(server.userData, 'server.log');
  if (existsSync(file))
    log(`${server.label} server.log tail:\n`, readFileSync(file, 'utf8').slice(-8000));
}

async function run() {
  const sshDir = mkdtempSync(join(tmpdir(), 'requests-ssh-'));
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
    const ba = await startAgent(b);
    await assignProfile(a, aa.sessionId, 'lead');

    phase("1. B's agent asks a confirm; A shows it tagged with B; A's answer reaches the agent");
    const confirmBefore = resultsOf(b, ba).length;
    typeCall(b, ba, 'request_input', { kind: 'confirm', title: CONFIRM_TITLE, wait_s: 60 });
    let confirm = null;
    await eventually("A shows B's confirm", async () => {
      confirm = await confirmRow(a, bId);
      return confirm !== null;
    });
    assert(
      confirm.machine === bId && confirm.origin === bId,
      `the confirm is not tagged with B: ${JSON.stringify(confirm)}`,
    );
    const approved = await answer(a, confirm.id, { outcome: 'approved' });
    assert(approved.ok === true, `the answer was refused: ${JSON.stringify(approved)}`);
    await eventually("B's agent gets the answer", () => resultsOf(b, ba).length > confirmBefore);
    const gotAnswer = resultsOf(b, ba).at(-1).result;
    assert(
      gotAnswer?.state === 'answered' && gotAnswer.answer?.outcome === 'approved',
      `B's agent did not receive the answer: ${JSON.stringify(gotAnswer)}`,
    );

    phase(
      '2. B assigns A Worker; a routed open_session from A asks on B; A allows; the call completes',
    );
    await assignPeer(b, aId, 'worker');
    const openedBefore = resultsOf(a, aa).length;
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
    const allowed = await answer(a, ask.id, { outcome: 'allowed' });
    assert(allowed.ok === true, `the allow was refused: ${JSON.stringify(allowed)}`);
    await eventually(
      "A's routed open_session is answered",
      () => resultsOf(a, aa).length > openedBefore,
    );
    const opened = resultsOf(a, aa).at(-1).result;
    assert(
      typeof opened?.session_id === 'string',
      `open_session after allow: ${JSON.stringify(opened)}`,
    );

    phase('3. A denies the next ask; the routed call is denied');
    const deniedBefore = resultsOf(a, aa).length;
    typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    let second = null;
    await eventually("A shows B's second permission ask", async () => {
      second = await permissionRow(a, bId);
      return second !== null && second.id !== ask.id;
    });
    const denied = await answer(a, second.id, { outcome: 'denied' });
    assert(denied.ok === true, `the deny was refused: ${JSON.stringify(denied)}`);
    await eventually(
      "A's routed open_session is answered",
      () => resultsOf(a, aa).length > deniedBefore,
    );
    const refusedCall = resultsOf(a, aa).at(-1).result;
    assert(
      refusedCall?.error?.code === 'denied',
      `a denied ask must give denied: ${JSON.stringify(refusedCall)}`,
    );

    phase('3b. remote grant save failure stays open; a new owner answer retries once');
    const beforeConsent = await b.c2.call('events.subscribe');
    const baselineGrants = beforeConsent.mcp.policy.grants;
    const baselineSessions = beforeConsent.sessions.map((session) => session.id).sort();
    const consentBefore = resultsOf(a, aa).length;
    typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    let consent = null;
    await eventually("A shows B's grantable ask", async () => {
      consent = await permissionRow(a, bId);
      return consent !== null && consent.id !== second.id;
    });
    const grantsPath = join(b.userData, 'conduit-mcp', 'grants.json');
    const grantsBackup = `${grantsPath}.net-requests-backup`;
    const hadGrantsFile = existsSync(grantsPath);
    const priorBytes = hadGrantsFile ? readFileSync(grantsPath) : null;
    if (hadGrantsFile) renameSync(grantsPath, grantsBackup);
    let failedConsent;
    try {
      mkdirSync(grantsPath);
      failedConsent = await answer(a, consent.id, {
        outcome: 'allowed',
        grant: { who: 'peer', on: 'anywhere', for: 'until-revoked' },
      });
      assert(
        failedConsent.ok === false &&
          failedConsent.reason === 'not_answerable' &&
          failedConsent.message.includes('save-failed'),
        `remote save failure lost its typed receipt: ${JSON.stringify(failedConsent)}`,
      );
      assert((await permissionRow(a, bId))?.id === consent.id, 'failed consent closed its mirror');
      const blocked = await b.c2.call('events.subscribe');
      assert(
        JSON.stringify(blocked.mcp.policy.grants) === JSON.stringify(baselineGrants),
        'failed consent created a grant',
      );
      assert(
        JSON.stringify(blocked.sessions.map((session) => session.id).sort()) ===
          JSON.stringify(baselineSessions),
        'failed consent opened a session',
      );
      assert(resultsOf(a, aa).length === consentBefore, 'failed consent ran the waiting call');
    } finally {
      if (existsSync(grantsPath)) rmdirSync(grantsPath);
      if (hadGrantsFile) renameSync(grantsBackup, grantsPath);
    }
    assert(
      !hadGrantsFile || readFileSync(grantsPath).equals(priorBytes),
      'obstruction restoration changed the original grants file',
    );
    assert((await permissionRow(a, bId))?.id === consent.id, 'recovery replaced the pending ask');
    assert(resultsOf(a, aa).length === consentBefore, 'recovery automatically ran the call');
    const recovered = await b.c2.call('events.subscribe');
    assert(
      JSON.stringify(recovered.mcp.policy.grants) === JSON.stringify(baselineGrants),
      'recovery automatically created a grant',
    );
    const retriedConsent = await answer(a, consent.id, {
      outcome: 'allowed',
      grant: { who: 'peer', on: 'anywhere', for: 'until-revoked' },
    });
    assert(
      retriedConsent.ok === true,
      `new answer retry failed: ${JSON.stringify(retriedConsent)}`,
    );
    await eventually('the retried call completes', () => resultsOf(a, aa).length > consentBefore);
    const retriedCall = resultsOf(a, aa).at(-1).result;
    assert(typeof retriedCall?.session_id === 'string', `retry: ${JSON.stringify(retriedCall)}`);
    const committed = await b.c2.call('events.subscribe');
    const newGrants = committed.mcp.policy.grants.filter(
      (grant) => !baselineGrants.some((prior) => prior.id === grant.id),
    );
    const newSessions = committed.sessions.filter(
      (session) => !baselineSessions.includes(session.id),
    );
    assert(
      newGrants.length === 1 && newGrants[0].state === 'active',
      `retry must create exactly one active grant: ${JSON.stringify(newGrants)}`,
    );
    assert(
      newSessions.length === 1 &&
        newSessions[0].id === retriedCall.session_id &&
        resultsOf(a, aa).length === consentBefore + 1,
      `retry must run exactly once: ${JSON.stringify(newSessions)}`,
    );
    assert(
      JSON.parse(readFileSync(grantsPath, 'utf8')).grants.some(
        (grant) => grant.id === newGrants[0].id,
      ),
      'successful retry grant was not persisted',
    );
    mkdirSync(join(REPO, '.autoloop', 'evidence'), { recursive: true });
    writeFileSync(
      join(REPO, '.autoloop', 'evidence', 'remote-receipt-runtime-cases.json'),
      `${JSON.stringify(
        {
          failedConsent,
          retriedConsent,
          newGrants: newGrants.length,
          newSessions: newSessions.length,
          resultCount: resultsOf(a, aa).length - consentBefore,
          recovery: 'explicit-new-answer',
          sameAnswerIdReplay: 'not exposed by owner C2 path',
        },
        null,
        2,
      )}\n`,
    );
    // The offline-answer case must retain its own permission ask rather than reuse this consent.
    const revoked = await b.c2.call('mcp.fromRenderer', {
      windowId: 1,
      message: { type: 'mcp:revokeGrant', requestId: 1, grantId: newGrants[0].id },
    });
    assert(revoked.reply?.ok === true, `grant cleanup: ${JSON.stringify(revoked)}`);

    phase('3c. a fresh Observer denial withdraws the pending ask permanently');
    const beforeWithdrawal = await b.c2.call('events.subscribe');
    const withdrawalSessions = beforeWithdrawal.sessions.map((session) => session.id).sort();
    const withdrawalGrants = beforeWithdrawal.mcp.policy.grants;
    const withdrawalBefore = resultsOf(a, aa).length;
    typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    let withdrawalAsk = null;
    await eventually('the fresh pending ask is mirrored on A', async () => {
      withdrawalAsk = await permissionRow(a, bId);
      return withdrawalAsk !== null && withdrawalAsk.id !== consent.id;
    });
    let withdrawalReceipt;
    try {
      await assignPeer(b, aId, 'observer');
      withdrawalReceipt = await answer(a, withdrawalAsk.id, {
        outcome: 'allowed',
        grant: { who: 'peer', on: 'anywhere', for: 'until-revoked' },
      });
      assert(
        withdrawalReceipt.ok === false &&
          withdrawalReceipt.reason === 'not_answerable' &&
          withdrawalReceipt.message.includes('Observer'),
        `fresh denial receipt: ${JSON.stringify(withdrawalReceipt)}`,
      );
      await eventually('A shows the same ask withdrawn', async () => {
        const requests = (await a.c2.call('events.subscribe')).mcp.requests;
        return (
          !requests.open.some((row) => row.id === withdrawalAsk.id) &&
          requests.ended.some((row) => row.id === withdrawalAsk.id && row.state === 'withdrawn')
        );
      });
      const ownerRequestId = withdrawalAsk.id.slice(0, withdrawalAsk.id.lastIndexOf('@'));
      const requestsPath = join(b.userData, 'conduit-mcp', 'requests.json');
      await eventually('B persists Conduit withdrawal with the actual refusal reason', () => {
        if (!existsSync(requestsPath)) return false;
        const record = JSON.parse(readFileSync(requestsPath, 'utf8')).requests.find(
          (row) => row.id === ownerRequestId,
        );
        return (
          record?.state === 'withdrawn' &&
          record.withdrawnBy === 'conduit' &&
          record.withdrawReason === withdrawalReceipt.message &&
          record.answer === null &&
          typeof record.endedAt === 'string'
        );
      });
      await eventually(
        'the waiting call settles without an owner cleanup answer',
        () => resultsOf(a, aa).length > withdrawalBefore,
      );
      const withdrawalCall = resultsOf(a, aa).at(-1).result;
      assert(
        withdrawalCall?.error?.code === 'policy_unavailable' &&
          withdrawalCall.error.message === withdrawalReceipt.message &&
          withdrawalCall.session_id === undefined,
        `withdrawal lost the fresh policy failure: ${JSON.stringify(withdrawalCall)}`,
      );
    } finally {
      await assignPeer(b, aId, 'worker');
    }
    const revived = await answer(a, withdrawalAsk.id, { outcome: 'allowed' });
    assert(
      revived.ok === false && revived.reason === 'already_ended',
      `relaxing policy revived the original ask: ${JSON.stringify(revived)}`,
    );
    const afterWithdrawal = await b.c2.call('events.subscribe');
    assert(
      JSON.stringify(afterWithdrawal.sessions.map((session) => session.id).sort()) ===
        JSON.stringify(withdrawalSessions),
      'withdrawn consent opened a session',
    );
    assert(
      JSON.stringify(afterWithdrawal.mcp.policy.grants) === JSON.stringify(withdrawalGrants),
      'withdrawn consent created a grant',
    );
    assert(
      resultsOf(a, aa).length === withdrawalBefore + 1,
      'withdrawn consent ran or settled more than once',
    );
    writeFileSync(
      join(REPO, '.autoloop', 'evidence', 'remote-receipt-withdraw-runtime-cases.json'),
      `${JSON.stringify(
        {
          withdrawalReceipt,
          revived,
          resultCount: 1,
          newGrants: 0,
          newSessions: 0,
          controllerActorReason: 'not present in current mirror contract',
        },
        null,
        2,
      )}\n`,
    );

    phase('4. an answer while the link is down is refused on A as peer_unreachable');
    typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    let third = null;
    await eventually("A shows B's third permission ask", async () => {
      third = await permissionRow(a, bId);
      return third !== null && third.id !== second.id;
    });
    // A second Lead agent takes B down: the first is still waiting on its routed call.
    const aa2 = await startAgent(a);
    await assignProfile(a, aa2.sessionId, 'lead');
    const down = await callTool(a, aa2, 'disconnect_machine', { machine: bId });
    assert(down.state === 'down', `disconnect_machine: ${JSON.stringify(down)}`);
    await eventually('A no longer has B up', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    const refused = await answer(a, third.id, { outcome: 'allowed' });
    assert(
      refused.ok === false && refused.reason === 'peer_unreachable',
      `an answer over a down link must be refused: ${JSON.stringify(refused)}`,
    );
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

let code = 0;
try {
  await run();
  log('PASS ✓');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL ✗', error?.stack || error?.message || String(error));
}
await finishScenario(code);

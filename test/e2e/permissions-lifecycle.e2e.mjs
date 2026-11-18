import { mkdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import { agentRecords, startAgent, startServer } from './net-helpers.mjs';

const log = makeLog('permissions-lifecycle');
const rows = (server, agent) => agentRecords(server, agent.sessionId, 'RESULT');
const state = async (server) => (await server.c2.call('events.subscribe')).mcp.policy;
const command = async (server, message) =>
  (await server.c2.call('mcp.fromRenderer', { windowId: 1, message })).reply;
const lifecycle = async (server, operation) => {
  const reply = await command(server, { type: 'mcp:grantLifecycle', requestId: 100, operation });
  assert(
    reply?.type === 'mcp:grantLifecycleResult' && reply.requestId === 100,
    JSON.stringify(reply),
  );
  return reply.result;
};
const grantOp = (kind, grant, policy) => ({
  kind,
  id: grant.id,
  revision: grant.lifecycleRevision ?? 0,
  expectedToken: policy.editToken,
});

async function run() {
  let server;
  try {
    server = await startServer('permissions-lifecycle');
    const caller = await startAgent(server);
    await server.c2.call('ui.presence', {
      windows: [
        {
          windowId: 1,
          focused: true,
          ready: true,
          visibleSessionIds: [caller.sessionId],
          ownedSessionIds: [caller.sessionId],
        },
      ],
    });
    let policy = await state(server);
    const assignment = await command(server, {
      type: 'mcp:saveAssignment',
      requestId: 1,
      point: { kind: 'session', sessionId: caller.sessionId },
      assignment: {
        profileId: 'lead',
        onScreenOnly: false,
        exceptions: [
          {
            tool: 'open_session',
            scope: { kind: 'anywhere' },
            rule: { decision: 'ask', when: 'always', reach: 'any' },
          },
        ],
      },
      expectedToken: policy.editToken,
    });
    assert(assignment?.result?.ok === true, `assignment: ${JSON.stringify(assignment)}`);
    const before = rows(server, caller).length;
    const eventStart = server.c2.events.length;
    server.c2.notify('term.input', {
      sessionId: caller.sessionId,
      generation: caller.generation,
      data: `call open_session ${JSON.stringify({ agent: 'e2e-fake-mcp', path: server.work, focus: false })}\r`,
    });
    let ask;
    assert(
      await until(() => {
        ask = server.c2.events
          .slice(eventStart)
          .find(
            (event) =>
              event.type === 'ui.post' &&
              event.data.message.type === 'mcp:ask' &&
              event.data.message.callerSessionId === caller.sessionId,
          )?.data.message;
        return ask !== undefined;
      }, 15_000),
      'no real permission ask',
    );
    const answer = await command(server, {
      type: 'mcp:permissionAnswer',
      requestId: ask.askId,
      answer: { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: '1h' } },
    });
    assert(answer?.ok === true, `grant answer: ${JSON.stringify(answer)}`);
    assert(
      await until(() => rows(server, caller).length > before, 15_000),
      'approved call did not settle',
    );
    assert(rows(server, caller)[before].result?.session_id, 'approved call did not execute');
    const sessionsBeforeRepeat = (await server.c2.call('events.subscribe')).sessions
      .map((entry) => entry.id)
      .sort();
    const repeat = await command(server, {
      type: 'mcp:permissionAnswer',
      requestId: ask.askId,
      answer: { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: '1h' } },
    });
    assert(repeat?.ok === false, `closed request accepted again: ${JSON.stringify(repeat)}`);
    assert(
      JSON.stringify(
        (await server.c2.call('events.subscribe')).sessions.map((entry) => entry.id).sort(),
      ) === JSON.stringify(sessionsBeforeRepeat),
      'closed answer ran an action',
    );
    const grantPath = join(server.userData, 'conduit-mcp', 'grants.json');
    const diskGrant = (id) =>
      JSON.parse(readFileSync(grantPath, 'utf8')).grants.find((g) => g.id === id);
    let grant;
    assert(
      await until(async () => {
        policy = await state(server);
        grant = policy.grants.find((g) => g.requestId === ask.askId && g.state === 'active');
        return grant !== undefined;
      }, 10_000),
      'approved grant missing',
    );

    phase('finite extend and durable revoke/undo');
    const expiry = Date.parse(grant.expiresAt);
    const extended = await lifecycle(server, grantOp('extend', grant, policy));
    assert(extended.ok === true, `extend: ${JSON.stringify(extended)}`);
    assert(
      Date.parse(diskGrant(grant.id).expiresAt) === expiry + 3_600_000,
      'extend did not durably add one hour',
    );
    policy = await state(server);
    grant = policy.grants.find((g) => g.id === grant.id);
    const revoked = await lifecycle(server, grantOp('revoke', grant, policy));
    assert(
      revoked.ok === true && typeof revoked.undoToken === 'string',
      `revoke: ${JSON.stringify(revoked)}`,
    );
    assert(diskGrant(grant.id).state === 'revoked', 'receipt preceded durable revoke');
    const undone = await lifecycle(server, { kind: 'undo', token: revoked.undoToken });
    assert(
      undone.ok === true && diskGrant(grant.id).state === 'active',
      `undo: ${JSON.stringify(undone)}`,
    );
    assert(
      (await lifecycle(server, { kind: 'undo', token: revoked.undoToken })).ok === false,
      'receipt reused',
    );

    phase('failed revoke has no authority receipt');
    policy = await state(server);
    grant = policy.grants.find((g) => g.id === grant.id);
    const backup = `${grantPath}.lifecycle-e2e-saved`;
    renameSync(grantPath, backup);
    try {
      mkdirSync(grantPath);
      try {
        const failed = await lifecycle(server, grantOp('revoke', grant, policy));
        assert(
          failed.ok === false && failed.error === 'save-failed' && !('undoToken' in failed),
          `failed revoke: ${JSON.stringify(failed)}`,
        );
      } finally {
        rmdirSync(grantPath);
      }
    } finally {
      renameSync(backup, grantPath);
    }
    const retry = await command(server, { type: 'mcp:policyRetry', requestId: 2 });
    assert(retry?.result?.ok === true, `retry: ${JSON.stringify(retry)}`);

    phase('restart invalidates a prior owner receipt');
    // Use a second real grant because the failed revoke remains restrictive in memory.
    const event2 = server.c2.events.length;
    const index2 = rows(server, caller).length;
    server.c2.notify('term.input', {
      sessionId: caller.sessionId,
      generation: caller.generation,
      data: `call open_session ${JSON.stringify({ agent: 'e2e-fake-mcp', path: server.work, focus: false })}\r`,
    });
    let ask2;
    assert(
      await until(() => {
        ask2 = server.c2.events
          .slice(event2)
          .find(
            (event) =>
              event.type === 'ui.post' &&
              event.data.message.type === 'mcp:ask' &&
              event.data.message.callerSessionId === caller.sessionId,
          )?.data.message;
        return ask2 !== undefined;
      }, 15_000),
      'second permission ask missing',
    );
    const accepted2 = await command(server, {
      type: 'mcp:permissionAnswer',
      requestId: ask2.askId,
      answer: { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: '1h' } },
    });
    assert(accepted2?.ok === true, `second grant: ${JSON.stringify(accepted2)}`);
    assert(
      await until(() => rows(server, caller).length > index2, 15_000),
      'second call did not settle',
    );
    policy = await state(server);
    const grant2 = policy.grants.find((g) => g.requestId === ask2.askId);
    assert(grant2, 'second grant missing');
    const receipt2 = await lifecycle(server, grantOp('revoke', grant2, policy));
    assert(
      receipt2.ok && receipt2.undoToken && diskGrant(grant2.id).state === 'revoked',
      'second revoke lacked durable receipt',
    );
    await server.restart();
    const stale = await lifecycle(server, { kind: 'undo', token: receipt2.undoToken });
    assert(
      stale.ok === false && diskGrant(grant2.id).state === 'revoked',
      `restart accepted old receipt: ${JSON.stringify(stale)}`,
    );
    log('finite extend, revoke/undo, failed save and restart receipt invalidation verified');
  } finally {
    await server?.stop();
  }
}

let code = 0;
try {
  await run();
  log('PASS ✓');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL ✗', error?.stack || String(error));
}
await finishScenario(code);

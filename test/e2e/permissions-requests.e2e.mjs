import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import { agentRecords, callTool, startAgent, startServer } from './net-helpers.mjs';

const log = makeLog('permissions-requests');
const args = (server) => ({ agent: 'e2e-fake-mcp', path: server.work, focus: false });
const rows = (server, agent) => agentRecords(server, agent.sessionId, 'RESULT');

async function command(server, windowId, message) {
  return (await server.c2.call('mcp.fromRenderer', { windowId, message })).reply;
}

async function ownerPage(server, windowId, state) {
  const reply = await command(server, windowId, {
    type: 'mcp:ownerPermissions:get',
    requestId: 123,
    state,
  });
  assert(reply?.type === 'mcp:ownerPermissions' && reply.requestId === 123, JSON.stringify(reply));
  return reply.page.permissions;
}

async function answer(server, windowId, requestId, value) {
  const reply = await command(server, windowId, {
    type: 'mcp:permissionAnswer',
    requestId,
    answer: value,
  });
  assert(reply?.type === 'mcp:permissionResult', JSON.stringify(reply));
  return reply;
}

function beginCall(server, agent) {
  const index = rows(server, agent).length;
  server.c2.notify('term.input', {
    sessionId: agent.sessionId,
    generation: agent.generation,
    data: `call open_session ${JSON.stringify(args(server))}\r`,
  });
  return index;
}

async function waitAsk(server, agent, since) {
  let ask;
  assert(
    await until(() => {
      ask = server.c2.events
        .slice(since)
        .find(
          (event) =>
            event.type === 'ui.post' &&
            event.data.message.type === 'mcp:ask' &&
            event.data.message.callerSessionId === agent.sessionId,
        )?.data.message;
      return ask !== undefined;
    }, 15_000),
    `no permission ask for ${agent.sessionId}`,
  );
  return ask;
}

async function obstruct(path, action) {
  const saved = `${path}.requests-e2e-saved`;
  const existed = existsSync(path);
  if (existed) renameSync(path, saved);
  try {
    mkdirSync(path);
    try {
      await action();
    } finally {
      rmdirSync(path);
    }
  } finally {
    if (existed) renameSync(saved, path);
  }
}

async function run() {
  let server;
  try {
    server = await startServer('permissions-requests');
    const caller = await startAgent(server);
    const other = await startAgent(server);
    await server.c2.call('ui.presence', {
      windows: [
        {
          windowId: 1,
          focused: true,
          ready: true,
          visibleSessionIds: [caller.sessionId],
          ownedSessionIds: [caller.sessionId],
        },
        {
          windowId: 2,
          focused: false,
          ready: true,
          visibleSessionIds: [other.sessionId],
          ownedSessionIds: [other.sessionId],
        },
      ],
    });
    const before = await server.c2.call('events.subscribe');
    const edited = await command(server, 1, {
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
      expectedToken: before.mcp.policy.editToken,
    });
    assert(edited?.result?.ok === true, `fixture assignment: ${JSON.stringify(edited)}`);
    const policyPath = join(server.userData, 'conduit-mcp', 'policy.json');
    const markerPath = join(server.userData, 'conduit-mcp', 'policy.last-good.json');
    const primaryBefore = readFileSync(policyPath, 'utf8');
    const baseline = await server.c2.call('events.subscribe');
    const eventStart = server.c2.events.length;
    const resultIndex = beginCall(server, caller);
    const ask = await waitAsk(server, caller, eventStart);
    const deny = { outcome: 'denied', scope: 'session' };

    phase('1. only the owning ready window can inspect or answer the live request');
    const owner = await ownerPage(server, 1, 'open');
    assert(
      owner.some((entry) => entry.id === ask.askId && entry.answerable),
      JSON.stringify(owner),
    );
    assert(
      !(await ownerPage(server, 2, 'open')).some((entry) => entry.id === ask.askId),
      'unrelated window saw request',
    );
    const foreign = await answer(server, 2, ask.askId, deny);
    assert(foreign?.ok === false, `unrelated window answered: ${JSON.stringify(foreign)}`);

    phase('2. marker and primary failures leave the same request actionable');
    for (const path of [markerPath, policyPath]) {
      await obstruct(path, async () => {
        const failed = await answer(server, 1, ask.askId, deny);
        assert(
          failed?.ok === false && failed.reason === 'not_answerable',
          `failed save accepted: ${JSON.stringify(failed)}`,
        );
        const open = await ownerPage(server, 1, 'open');
        assert(
          open.some((entry) => entry.id === ask.askId && entry.answerable),
          `request lost: ${JSON.stringify(open)}`,
        );
        assert(rows(server, caller).length === resultIndex, 'caller settled after failed save');
      });
      assert(readFileSync(policyPath, 'utf8') === primaryBefore, 'failed save changed primary');
    }

    phase('3. successful denial is durable before receipt and blocks later calls');
    const accepted = await answer(server, 1, ask.askId, deny);
    assert(accepted?.ok === true, `denial failed: ${JSON.stringify(accepted)}`);
    const persisted = JSON.parse(readFileSync(policyPath, 'utf8'));
    assert(
      persisted.sessionDenials.some(
        (entry) =>
          entry.requestId === ask.askId &&
          entry.sessionId === caller.sessionId &&
          entry.tool === 'open_session',
      ),
      'reply preceded durable denial',
    );
    assert(
      await until(() => rows(server, caller).length > resultIndex, 10_000),
      'denied caller did not settle',
    );
    assert(rows(server, caller)[resultIndex].result?.error, 'denied call executed');
    assert(
      await until(
        async () => (await ownerPage(server, 1, 'closed')).some((entry) => entry.id === ask.askId),
        10_000,
      ),
      'closed owner view missing denial',
    );
    assert(
      !(await ownerPage(server, 2, 'closed')).some((entry) => entry.id === ask.askId),
      'unrelated window saw closed denial',
    );
    const repeatStart = server.c2.events.length;
    const repeated = await callTool(server, caller, 'open_session', args(server));
    assert(repeated?.error, `session denial did not refuse repeat: ${JSON.stringify(repeated)}`);
    assert(
      !server.c2.events
        .slice(repeatStart)
        .some(
          (event) =>
            event.type === 'ui.post' &&
            event.data.message.type === 'mcp:ask' &&
            event.data.message.callerSessionId === caller.sessionId,
        ),
      'repeat reopened ask',
    );
    const after = await server.c2.call('events.subscribe');
    assert(
      JSON.stringify(after.mcp.policy.grants) === JSON.stringify(baseline.mcp.policy.grants),
      'denial created a grant',
    );
    assert(
      JSON.stringify(after.sessions.map((entry) => entry.id).sort()) ===
        JSON.stringify(baseline.sessions.map((entry) => entry.id).sort()),
      'denial opened a session',
    );

    const otherStart = server.c2.events.length;
    const otherIndex = beginCall(server, other);
    const otherAsk = await waitAsk(server, other, otherStart);
    assert(
      (await ownerPage(server, 2, 'open')).some(
        (entry) => entry.id === otherAsk.askId && entry.answerable,
      ),
      'other session affected by denial',
    );
    assert(
      (await answer(server, 2, otherAsk.askId, { outcome: 'denied' }))?.ok === true,
      'other request did not remain actionable',
    );
    assert(
      await until(() => rows(server, other).length > otherIndex, 10_000),
      'other request did not settle',
    );
    log('owner isolation, failed saves, durable session denial and independent session verified');
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
  log('FAIL ✗', error?.stack || error?.message || String(error));
}
await finishScenario(code);

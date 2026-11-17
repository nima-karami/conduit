import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import { agentRecords, startAgent, startServer } from './net-helpers.mjs';

const log = makeLog('permissions-running');

async function saveReach(server, callerId, reach) {
  const before = await server.c2.call('events.subscribe');
  const result = await server.c2.call('mcp.fromRenderer', {
    windowId: 1,
    message: {
      type: 'mcp:saveAssignment',
      requestId: 1,
      point: { kind: 'session', sessionId: callerId },
      assignment: {
        profileId: 'lead',
        onScreenOnly: false,
        exceptions: [
          {
            tool: 'close_session',
            scope: { kind: 'anywhere' },
            rule: { decision: 'allow', when: 'always', reach },
          },
        ],
      },
      expectedToken: before.mcp.policy.editToken,
    },
  });
  assert(
    result.reply?.type === 'mcp:policyEditResult' && result.reply.result.ok === true,
    `reach ${reach} edit refused: ${JSON.stringify(result)}`,
  );
  const after = await server.c2.call('events.subscribe');
  const assignment = after.mcp.policy.assignments.find(
    (entry) => entry.point.kind === 'session' && entry.point.sessionId === callerId,
  )?.assignment;
  assert(
    after.mcp.policy.editToken !== before.mcp.policy.editToken &&
      assignment?.profileId === 'lead' &&
      assignment.exceptions.some(
        (entry) =>
          entry.tool === 'close_session' &&
          entry.rule.reach === reach &&
          entry.rule.when === 'always' &&
          entry.rule.decision === 'allow',
      ),
    `reach ${reach} was not published: ${JSON.stringify(assignment)}`,
  );
}

async function run() {
  let server;
  try {
    server = await startServer('permissions-running');
    const caller = await startAgent(server);
    const targetA = await startAgent(server);
    const targetB = await startAgent(server);
    const ids = [caller.sessionId, targetA.sessionId, targetB.sessionId];
    await server.c2.call('ui.presence', {
      windows: [
        { windowId: 1, focused: true, ready: true, visibleSessionIds: ids, ownedSessionIds: ids },
      ],
    });
    await saveReach(server, caller.sessionId, 'any');
    const baseline = await server.c2.call('events.subscribe');
    for (const target of [targetA, targetB]) {
      const session = baseline.sessions.find((entry) => entry.id === target.sessionId);
      assert(session && !session.openedBy, 'targets must be human-created, unrelated sessions');
    }
    const expectedNames = [targetA, targetB].map(
      (target) => baseline.mcp.sessions[target.sessionId].handle,
    );
    const grantIds = baseline.mcp.policy.grants.map((grant) => grant.id);
    const resultBefore = agentRecords(server, caller.sessionId, 'RESULT').length;
    const eventBefore = server.c2.events.length;
    const dispatches = () =>
      server.c2.events
        .slice(eventBefore)
        .filter(
          (event) =>
            event.type === 'ui.post' &&
            event.data.message.type === 'mcp:ui' &&
            event.data.message.sessionId === caller.sessionId &&
            event.data.message.action.kind === 'closeSession',
        );

    phase('1. the real batch close waits for its first owner UI response');
    server.c2.notify('term.input', {
      sessionId: caller.sessionId,
      generation: caller.generation,
      data: `call close_session ${JSON.stringify({ sessions: [targetA.sessionId, targetB.sessionId] })}\r`,
    });
    assert(await until(() => dispatches().length > 0, 15_000), 'no first close UI dispatch');
    const first = dispatches()[0].data;
    assert(
      first.route.kind === 'window' &&
        first.route.windowId === 1 &&
        first.message.action.target === targetA.sessionId &&
        dispatches().length === 1,
      `unexpected first dispatch: ${JSON.stringify(first)}`,
    );
    assert(
      agentRecords(server, caller.sessionId, 'RESULT').length === resultBefore,
      'batch settled before its held UI response',
    );

    phase('2. narrowing current reach stops acknowledgement and subsequent dispatch');
    await saveReach(server, caller.sessionId, 'opened');
    // This peer reports completion without performing a renderer action; no rollback is implied.
    await server.c2.call('mcp.fromRenderer', {
      windowId: 1,
      message: {
        type: 'mcp:uiResult',
        requestId: first.message.requestId,
        result: { kind: 'closeSession', ok: true },
      },
    });
    assert(
      await until(
        () => agentRecords(server, caller.sessionId, 'RESULT').length > resultBefore,
        10_000,
      ),
      'batch did not settle after the UI response',
    );
    const results = agentRecords(server, caller.sessionId, 'RESULT');
    const result = results[resultBefore].result;
    assert(
      results.length === resultBefore + 1 && result?.results?.length === 2,
      `unexpected batch result: ${JSON.stringify(result)}`,
    );
    const messages = [
      'Permissions changed while running; UI work may already have completed',
      'Permissions changed while running',
    ];
    for (const [index, entry] of result.results.entries()) {
      assert(
        entry.session === expectedNames[index] &&
          entry.closed === false &&
          entry.error?.code === 'tool_disabled' &&
          entry.error.message === messages[index],
        `target ${index} lost its truthful refusal: ${JSON.stringify(entry)}`,
      );
    }
    assert(
      dispatches().length === 1 &&
        !dispatches().some((event) => event.data.message.action.target === targetB.sessionId),
      'stale authority dispatched another target',
    );
    const after = await server.c2.call('events.subscribe');
    assert(
      JSON.stringify(after.mcp.policy.grants.map((grant) => grant.id)) === JSON.stringify(grantIds),
      'running freshness refusal created a grant',
    );
    assert(
      ids.every((id) => after.sessions.some((session) => session.id === id)),
      'the UI stand-in unexpectedly performed a physical close',
    );
    log('one real UI dispatch; first result uncertain, second refused; no new grants', result);
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

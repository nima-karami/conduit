import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import { callTool, startAgent, startServer } from './net-helpers.mjs';

const log = makeLog('permissions-activity-restart');
const snapshot = (server) => server.c2.call('events.subscribe');
const owner = async (server, sessionId) => {
  await server.c2.call('ui.presence', {
    windows: [
      {
        windowId: 1,
        focused: true,
        ready: true,
        visibleSessionIds: [sessionId],
        ownedSessionIds: [sessionId],
      },
    ],
  });
};
const command = async (server, message) =>
  (await server.c2.call('mcp.fromRenderer', { windowId: 1, message })).reply;
const issue = (server, row) =>
  command(server, { type: 'mcp:allowOnce', requestId: 3, activityId: row.id, at: row.at });

async function run() {
  let server;
  try {
    server = await startServer('permissions-activity-restart');
    const caller = await startAgent(server);
    const target = await startAgent(server);
    const other = await startAgent(server);
    await owner(server, caller.sessionId);
    const before = await snapshot(server);
    const assignment = await command(server, {
      type: 'mcp:saveAssignment',
      requestId: 1,
      point: { kind: 'session', sessionId: caller.sessionId },
      assignment: {
        profileId: 'lead',
        onScreenOnly: false,
        exceptions: [
          {
            tool: 'close_session',
            scope: { kind: 'anywhere' },
            rule: { decision: 'deny', when: 'always', reach: 'any' },
          },
        ],
      },
      expectedToken: before.mcp.policy.editToken,
    });
    assert(assignment?.result?.ok === true, `deny assignment: ${JSON.stringify(assignment)}`);

    phase('Persist a real close-session denial');
    const denied = await callTool(server, caller, 'close_session', { session: target.sessionId });
    assert(denied?.error?.code === 'tool_disabled', `initial denial: ${JSON.stringify(denied)}`);
    const query = {
      type: 'mcp:activity:get',
      requestId: 2,
      query: { sessionId: caller.sessionId, action: 'close_session', decision: 'deny' },
    };
    const page = await command(server, query);
    assert(
      page?.type === 'mcp:activity' && page.page.error === null,
      `query: ${JSON.stringify(page)}`,
    );
    const row = page.page.rows.find(
      (item) => item.target === target.sessionId && item.outcome === 'denied',
    );
    assert(
      row?.trace?.facts?.principal?.generation === caller.generation,
      'denial lacks live generation trace',
    );
    assert(typeof row.id === 'string' && typeof row.at === 'string', 'denial lacks exact stamp');

    phase('Restart the deciding server and adopt the same process');
    await server.restart();
    let adopted;
    assert(
      await until(async () => {
        adopted = await snapshot(server);
        return adopted.sessions.some((entry) => entry.id === caller.sessionId && entry.runtime);
      }, 15_000),
      'caller was not adopted',
    );
    await owner(server, caller.sessionId);
    const afterPage = await command(server, query);
    assert(
      afterPage?.type === 'mcp:activity' &&
        afterPage.page.error === null &&
        afterPage.page.rows.some((item) => item.id === row.id && item.at === row.at),
      'exact denied row did not survive restart',
    );
    const generation = adopted.sessions.find((entry) => entry.id === caller.sessionId)?.runtime
      ?.generation;
    if (generation !== caller.generation) {
      const stale = await issue(server, row);
      assert(stale?.ok === false, `changed generation accepted: ${JSON.stringify(stale)}`);
      log(
        `adopted generation changed from ${caller.generation} to ${generation}; stale receipt refused`,
      );
      return;
    }

    phase('Authorize one retry of the exact target');
    const issued = await issue(server, row);
    assert(issued?.ok === true, `allow once: ${JSON.stringify(issued)}`);
    const wrongTarget = await callTool(server, caller, 'close_session', {
      session: other.sessionId,
    });
    assert(
      wrongTarget?.error?.code === 'tool_disabled',
      `other target: ${JSON.stringify(wrongTarget)}`,
    );
    const current = await snapshot(server);
    assert(
      current.sessions.some((entry) => entry.id === other.sessionId),
      'other target was closed',
    );
    const retried = await callTool(server, caller, 'close_session', { session: target.sessionId });
    assert(retried?.closed === target.sessionId, `retry: ${JSON.stringify(retried)}`);
    const final = await snapshot(server);
    assert(
      !final.sessions.some((entry) => entry.id === target.sessionId),
      'retry did not close target',
    );
    const repeated = await issue(server, row);
    assert(repeated?.ok === false, `receipt reused: ${JSON.stringify(repeated)}`);
    log('persisted denial authorized exactly one agent retry after adoption');
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

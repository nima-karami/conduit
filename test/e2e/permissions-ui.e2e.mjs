import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  records,
  resultAfter,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-ui');
const { env } = isolatedHome(userDataDir);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true } }),
);

async function activity(page, query) {
  const result = await page.evaluate(
    ({ query }) =>
      new Promise((resolve) => {
        const requestId = Math.floor(Math.random() * 1_000_000_000);
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, 10_000);
        const off = window.agentDeck.subscribe((message) => {
          if (message.type !== 'mcp:activity' || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          resolve(message.page);
        });
        window.agentDeck.post({ type: 'mcp:activity:get', requestId, query });
      }),
    { query },
  );
  assert(result !== null, 'Activity query did not answer');
  return result;
}

async function ownerEdit(page, command, responseType = 'mcp:policyEditResult') {
  return page.evaluate(
    ({ command, responseType }) =>
      new Promise((resolve, reject) => {
        window.__freshnessSeq = (window.__freshnessSeq ?? 0) + 1;
        const requestId = command.requestId ?? window.__freshnessSeq;
        const timer = setTimeout(() => {
          off();
          reject(new Error(`No reply for ${command.type}`));
        }, 10_000);
        const off = window.agentDeck.subscribe((message) => {
          if (message.type !== responseType || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          resolve(responseType === 'mcp:policyEditResult' ? message.result : message);
        });
        window.agentDeck.post({ ...command, requestId });
      }),
    { command, responseType },
  );
}

await runScenario(
  'permissions-ui',
  async ({ page, log }) => {
    await tapMcp(page);
    const first = await openFake(page, mkdtempSync(join(tmpdir(), 'permissions-ui-first-')));
    const second = await openFake(page, mkdtempSync(join(tmpdir(), 'permissions-ui-second-')));
    const state = await mcpState(page);
    assert(
      state.policy.profiles.some(
        (profile) => profile.id === 'lead' && profile.rules.open_terminal.decision === 'allow',
      ),
      'full built-in rules are missing',
    );
    assert(Array.isArray(state.policy.assignments), 'full assignments missing');

    const body = 'permissions-ui-private-body-4382';
    const result = await callTool(page, first.sessionId, 'send_message', { to: ['you'], body });
    assert(!result?.error, `send_message failed: ${JSON.stringify(result)}`);
    await callTool(page, first.sessionId, 'list_sessions', {});
    await callTool(page, second.sessionId, 'list_sessions', {});
    const all = await activity(page, { sessionId: first.sessionId });
    assert(all.error === null, `Activity failed: ${all.error}`);
    assert(all.rows.length > 1, 'real host Activity rows missing');
    assert(
      all.rows.every((row) => row.principal.sessionId === first.sessionId),
      'session filter leaked another session',
    );
    assert(
      all.rows.some((row) => row.action === 'list_sessions' && row.count > 0),
      'pending hourly reads missing',
    );
    assert(
      all.rows.some((row) => row.action === 'send_message'),
      'persisted decided action missing',
    );
    assert(!JSON.stringify(all).includes(body), 'Activity exposed a message body');
    log('real persisted action and pending count queried; session filter and privacy verified');

    const one = await activity(page, { sessionId: first.sessionId, limit: 1 });
    assert(
      one.rows.length === 1 && typeof one.next === 'string',
      'first page has no stable cursor',
    );
    const next = await activity(page, { sessionId: first.sessionId, limit: 1, before: one.next });
    assert(
      next.error === null && next.rows.length === 1 && next.rows[0].id !== one.rows[0].id,
      'cursor duplicated or skipped Activity',
    );
    const none = await activity(page, { sessionId: 'does-not-exist' });
    assert(none.error === null && none.rows.length === 0, 'empty filter fabricated rows');
    const invalid = await activity(page, { limit: 201 });
    assert(
      typeof invalid.error === 'string' && invalid.rows.length === 0,
      'host accepted invalid Activity limit',
    );
    log('pagination, empty filter and host validation verified');

    const point = { kind: 'session', sessionId: first.sessionId };
    const original =
      (await mcpState(page)).policy.assignments.find(
        (entry) => entry.point.kind === 'session' && entry.point.sessionId === first.sessionId,
      )?.assignment ?? null;
    const assignment = (reach) => ({
      profileId: 'worker',
      onScreenOnly: false,
      exceptions: [
        {
          tool: 'close_session',
          scope: { kind: 'anywhere' },
          rule: { decision: 'ask', when: 'always', reach },
        },
      ],
    });
    const saveAssignment = async (value) => {
      const token = (await mcpState(page)).policy.editToken;
      const result = await ownerEdit(page, {
        type: 'mcp:saveAssignment',
        point,
        assignment: value,
        expectedToken: token,
      });
      assert(result.ok === true, `assignment refused: ${JSON.stringify(result)}`);
      assert(
        await until(async () => (await mcpState(page)).policy.editToken !== token, 10_000),
        'assignment broadcast did not advance',
      );
    };
    await page.evaluate(() => {
      window.__freshnessAsks = [];
      window.__freshnessClosed = [];
      window.agentDeck.subscribe((message) => {
        if (message.type === 'mcp:ask') window.__freshnessAsks.push(message);
        if (message.type === 'mcp:askClosed') window.__freshnessClosed.push(message.askId);
      });
    });
    let receipt;
    let toolResult;
    try {
      const target = await page.evaluate(
        (id) => window.__sessions.find((session) => session.id === id),
        second.sessionId,
      );
      assert(target && !target.openedBy, 'target must be human-opened and unrelated to caller');
      await saveAssignment(assignment('any'));
      const beforeGrants = (await mcpState(page)).policy.grants.map((grant) => grant.id);
      const before = await startCall(page, first.sessionId, 'close_session', {
        session: second.handle,
      });
      let ask;
      assert(
        await until(async () => {
          ask = await page.evaluate(
            (id) => window.__freshnessAsks.find((entry) => entry.callerSessionId === id),
            first.sessionId,
          );
          return ask !== undefined;
        }, 10_000),
        'close-session call did not raise an ask',
      );
      await saveAssignment(assignment('opened'));
      assert(
        await page.evaluate(
          ({ caller, askId }) =>
            window.__mcp.awaitingApproval.includes(caller) &&
            !window.__freshnessClosed.includes(askId) &&
            window.__freshnessAsks.filter((entry) => entry.callerSessionId === caller).length === 1,
          { caller: first.sessionId, askId: ask.askId },
        ),
        'narrowing replaced or ended the original ask',
      );
      receipt = await ownerEdit(
        page,
        { type: 'mcp:permissionAnswer', requestId: ask.askId, answer: { outcome: 'allowed' } },
        'mcp:permissionResult',
      );
      const reason = 'Permissions changed after this action was prepared';
      assert(
        receipt.ok === false && receipt.reason === 'not_answerable' && receipt.message === reason,
        `stale owner answer was not refused: ${JSON.stringify(receipt)}`,
      );
      toolResult = await resultAfter(first.sessionId, before, 10_000);
      assert(
        toolResult?.error?.code === 'tool_disabled' && toolResult.error.message === reason,
        `stale prepared call result: ${JSON.stringify(toolResult)}`,
      );
      assert(
        records(first.sessionId, 'RESULT').length === before + 1,
        'call settled more than once',
      );
      assert(
        await page.evaluate(
          (id) => window.__sessions.some((session) => session.id === id),
          second.sessionId,
        ),
        'stale consent closed the unrelated target',
      );
      assert(
        JSON.stringify((await mcpState(page)).policy.grants.map((grant) => grant.id)) ===
          JSON.stringify(beforeGrants),
        'stale consent created a grant',
      );
      const requestsPath = join(userDataDir, 'conduit-mcp', 'requests.json');
      assert(
        await until(() => {
          if (!existsSync(requestsPath)) return false;
          const row = JSON.parse(readFileSync(requestsPath, 'utf8')).requests.find(
            (entry) => entry.id === ask.askId,
          );
          return (
            row?.state === 'withdrawn' &&
            row.withdrawnBy === 'conduit' &&
            row.answer === null &&
            row.withdrawReason === reason &&
            typeof row.endedAt === 'string'
          );
        }, 10_000),
        'canonical request did not persist Conduit withdrawal',
      );
      log(
        'stale reach-any consent refused after reach-opened assignment; target and grants unchanged',
      );
    } finally {
      await saveAssignment(original);
    }
    mkdirSync(join(process.cwd(), '.autoloop', 'evidence'), { recursive: true });
    writeFileSync(
      join(process.cwd(), '.autoloop', 'evidence', 'local-freshness-runtime-cases.json'),
      `${JSON.stringify(
        { receipt, toolResult, targetRemained: true, newGrants: 0, canonicalWithdrawal: 'conduit' },
        null,
        2,
      )}\n`,
    );
  },
  { userDataDir, env },
);

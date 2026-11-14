/**
 * requests-sources: Conduit raises requests from what it observes, not only from agents
 * (spec docs/specs/2026-11-14-user-input-requests.md §4.1 attend, §4.10 prose questions;
 * plan docs/plans/2026-11-14-request-queue-machinery.plan.md Slice 4; REQ-D9 measured in
 * docs/runs/2026-11-14-CON-21/osc7501.md).
 *   (a) a session hidden behind another reports OSC 7501 blocked/permission → one open `attend`
 *       request for it; the report clearing to idle → the request is `resolved`.
 *   (b) an agent sends the human a message of kind question → one open `message` request, and the
 *       Messages chip item for that thread is dropped (counted once); answering it from the renderer
 *       posts an ordinary reply the agent reads in the same thread, and the request is answered.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRow } from './attention-footer-helpers.mjs';
import {
  callTool,
  fakeAgentProfile,
  mcpState,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, openSession, phase, REPO, runScenario, typeLine } from './harness.mjs';

/** hc reads 7501 fields separated by ':', measured in docs/runs/2026-11-14-CON-21/osc7501.md. */
function report7501(page, sid, payload) {
  return typeLine(
    page,
    sid,
    `node -e "process.stdout.write(String.fromCharCode(27)+']7501;${payload}'+String.fromCharCode(7))"`,
  );
}

const requests = async (page) => (await mcpState(page))?.requests ?? { open: [], ended: [] };

function answer(page, requestId, outcome) {
  return page.evaluate(
    ({ requestId, outcome }) =>
      new Promise((resolve) => {
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'mcp:requestResult' || m.requestId !== requestId) return;
          off?.();
          resolve(m.result);
        });
        window.agentDeck.post({ type: 'mcp:requestAnswer', requestId, answer: outcome });
      }),
    { requestId, outcome },
  );
}

await runScenario(
  'requests-sources',
  async ({ page, log }) => {
    await tapMcp(page);

    phase('attend from OSC 7501');
    const repo = REPO.replace(/\\/g, '/');
    const R = await openSession(page, { path: repo });
    const P = await openSession(page, { path: repo });
    await selectRow(page, P);
    await report7501(page, R, 'state=blocked:kind=permission');
    let attend = null;
    assert(
      await until(async () => {
        attend = (await requests(page)).open.find(
          (r) => r.source === 'observed' && r.session === R,
        );
        return attend !== undefined;
      }, 20_000),
      'no attend request for the hidden blocked session',
    );
    assert(
      attend.kind === 'attend' && attend.blocked === 'permission',
      `attend request is wrong: ${JSON.stringify(attend)}`,
    );
    await report7501(page, R, 'state=idle');
    assert(
      await until(async () => {
        const st = await requests(page);
        return (
          !st.open.some((r) => r.id === attend.id) &&
          st.ended.some((r) => r.id === attend.id && r.state === 'resolved')
        );
      }, 20_000),
      'the attend request did not resolve when the prompt cleared',
    );
    log('attend raised while hidden ✓, resolved on clear ✓');

    phase('question message');
    const work = mkdtempSync(join(tmpdir(), 'requests-sources-'));
    const a = await openFake(page, work);
    const sent = await callTool(page, a.sessionId, 'send_message', {
      to: ['you'],
      kind: 'question',
      subject: 'Migration',
      body: 'Blue/green or in place?',
    });
    assert(typeof sent?.thread_id === 'string', `send_message failed: ${JSON.stringify(sent)}`);
    let question = null;
    assert(
      await until(async () => {
        question = (await requests(page)).open.find(
          (r) => r.source === 'message' && r.thread === sent.thread_id,
        );
        return question !== undefined;
      }, 20_000),
      'no message request for the question',
    );
    const chip = ((await mcpState(page))?.attention ?? []).filter(
      (i) => i.threadId === sent.thread_id,
    );
    assert(chip.length === 0, `the question is counted twice: ${JSON.stringify(chip)}`);
    const result = await answer(page, question.id, { outcome: 'answered', text: 'Blue/green' });
    assert(result.ok === true, `the answer was refused: ${JSON.stringify(result)}`);
    let reply = null;
    assert(
      await until(
        async () => {
          const read = await callTool(page, a.sessionId, 'read_inbox', {});
          reply = read?.messages?.find((m) => m.thread_id === sent.thread_id) ?? null;
          return reply !== null;
        },
        20_000,
        1_000,
      ),
      'the agent never read a reply in its thread',
    );
    assert(reply.body.includes('Blue/green'), `the reply body is wrong: ${reply.body}`);
    assert(reply.request_id === undefined, 'the reply should be an ordinary message');
    log('question raised once ✓, answered as a thread reply ✓');
  },
  { userDataDir: fakeAgentProfile('requests-sources') },
);

/**
 * requests-agent: an agent asks the human through request_input, and the answer reaches it
 * (spec docs/specs/2026-11-14-user-input-requests.md §4.3, §9 "A late answer still reaches the agent";
 * plan docs/plans/2026-11-14-request-queue-machinery.plan.md Slice 2).
 * The test answers through the same renderer path a window uses (`mcp:requestAnswer`).
 *   (a) answered while the call waits → the call returns state answered with the pick.
 *   (b) not answered within wait_s → the call returns open; the later answer arrives through
 *       read_inbox with request_id, and the human's thread list stays free of it.
 *   (c) the CLI cancels a waiting call → no reply, the request stays open; an identical retry
 *       attaches to the same request id.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  mcpState,
  openFake,
  records,
  resultAfter,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, runScenario, typeLine } from './harness.mjs';

const OPTIONS = [{ label: 'Blue/green' }, { label: 'In place' }];
const choose = (title, waitS) => ({ kind: 'choose', title, options: OPTIONS, wait_s: waitS });

/** The open request with this title, from the host's broadcast state. */
async function openRequest(page, title) {
  const st = await mcpState(page);
  return st?.requests?.open.find((r) => r.title === title) ?? null;
}

/** Answer through the renderer message path and resolve the host's `mcp:requestResult`. */
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
  'requests-agent',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'requests-agent-'));
    const a = await openFake(page, work);
    log(`agent ${a.handle}`);

    phase('answered while waiting');
    let before = await startCall(page, a.sessionId, 'request_input', choose('Which deploy?', 60));
    let req = null;
    assert(
      await until(async () => {
        req = await openRequest(page, 'Which deploy?');
        return req?.waiting === true;
      }, 15_000),
      'the request never showed as waiting in mcp:state',
    );
    const first = await answer(page, req.id, { outcome: 'chosen', values: ['Blue/green'] });
    assert(first.ok === true, `the answer was refused: ${JSON.stringify(first)}`);
    const answered = await resultAfter(a.sessionId, before, 15_000);
    assert(
      answered?.state === 'answered' && answered.answer?.values?.[0] === 'Blue/green',
      `the waiting call did not return the answer: ${JSON.stringify(answered)}`,
    );
    const again = await answer(page, req.id, { outcome: 'chosen', values: ['In place'] });
    assert(
      again.ok === false && again.reason === 'already_ended',
      `a second answer was not refused: ${JSON.stringify(again)}`,
    );
    log('answered in time ✓, second answer refused ✓');

    phase('late answer');
    const open = await callTool(page, a.sessionId, 'request_input', choose('Which migration?', 0));
    assert(open?.state === 'open' && typeof open.request_id === 'string', JSON.stringify(open));
    const late = await answer(page, open.request_id, { outcome: 'chosen', values: ['In place'] });
    assert(late.ok === true, `the late answer was refused: ${JSON.stringify(late)}`);
    let inbox = null;
    assert(
      await until(
        async () => {
          const read = await callTool(page, a.sessionId, 'read_inbox', {});
          inbox = read?.messages?.find((m) => m.request_id === open.request_id) ?? null;
          return inbox !== null;
        },
        20_000,
        1_000,
      ),
      'read_inbox never carried the late answer',
    );
    const body = JSON.parse(inbox.body.slice(inbox.body.indexOf('{')));
    assert(
      body.answer?.outcome === 'chosen' && body.answer.values?.[0] === 'In place',
      `the late answer body is wrong: ${inbox.body}`,
    );
    const threads = (await mcpState(page))?.threads ?? [];
    assert(
      !threads.some((t) => t.threadId === inbox.thread_id),
      'the late answer shows in the human thread list',
    );
    log('late answer via read_inbox ✓, hidden from Messages ✓');

    phase('cancel then retry attaches');
    before = await startCall(page, a.sessionId, 'request_input', choose('Rebase or merge?', 60));
    let waiting = null;
    assert(
      await until(async () => {
        waiting = await openRequest(page, 'Rebase or merge?');
        return waiting?.waiting === true;
      }, 15_000),
      'the third request never waited',
    );
    await typeLine(page, a.sessionId, 'cancel');
    assert(
      await until(() => records(a.sessionId, 'CANCEL').length > 0, 5_000),
      'the fake never sent notifications/cancelled',
    );
    assert(
      await until(
        async () => (await openRequest(page, 'Rebase or merge?'))?.waiting === false,
        5_000,
      ),
      'the cancelled request did not stop waiting, or left the open list',
    );
    const replied = await resultAfter(a.sessionId, before, 2_000);
    assert(replied === null, `a cancelled call got a reply: ${JSON.stringify(replied)}`);
    const retry = await callTool(page, a.sessionId, 'request_input', choose('Rebase or merge?', 0));
    assert(
      retry?.request_id === waiting.id,
      `the retry did not attach: ${JSON.stringify(retry)} vs ${waiting.id}`,
    );
    log('cancel keeps it open ✓, retry attaches ✓');
  },
  { userDataDir: fakeAgentProfile('requests-agent') },
);

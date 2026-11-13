/**
 * conduit-mcp-midturn — CON-172: a notice reaches an agent that is busy but accepts input mid-turn
 * (the e2e-only `fake-queue` adapter, fake `busyq`), so the notice queues instead of waiting for idle.
 * Fake MCP agents A, B and C in one folder; A is the sender.
 *   (a) B runs `busyq 20000`; A sends B a message: within 5 s a notice is submitted in B,
 *       while B is still busy.
 *   (b) C runs `busyq 40000` with a human draft (`fix the`, no Enter) typed in it; A sends C a
 *       message: for 8 s no notice reaches C. Then the draft is cleared (Ctrl+C, the gate test's
 *       precedent): a notice reaches C, and C is still busy. C has no earlier notice, so
 *       the 30 s notice spacing cannot be what held it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  FAKE_QUEUE_AGENT_ID,
  fakeQueueAgentProfile,
  keys,
  mcpState,
  notices,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, pollUntil, runScenario, typeLine } from './harness.mjs';

const BUSY_B_MS = 20_000;
const BUSY_C_MS = 40_000;
const NOTICE_WITHIN_MS = 5_000;
const NEGATIVE_WINDOW_MS = 8_000;
const CLEARED_NOTICE_WITHIN_MS = 8_000;
/** Gates that close for the agent's startup, not for its input state. */
const STARTUP_GATES = ['settling', 'no-connection', 'not-running', 'off', 'paused'];

const busyOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id)?.busy === true, sid);

await runScenario(
  'conduit-mcp-midturn',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-midturn-'));

    const a = await openFake(page, work);
    const b = await openFake(page, work, { agentId: FAKE_QUEUE_AGENT_ID });
    const c = await openFake(page, work, { agentId: FAKE_QUEUE_AGENT_ID });
    log(`A=${a.handle} B=${b.handle} C=${c.handle}`);
    for (const target of [b, c]) {
      const settled = await pollUntil(async () => {
        const gate = (await mcpState(page))?.sessions?.[target.sessionId]?.gate;
        return gate !== undefined && !STARTUP_GATES.includes(gate) ? gate : null;
      }, 15_000);
      assert(settled, `${target.handle} never left its startup gate`);
    }

    const send = async (to, body) => {
      const r = await callTool(page, a.sessionId, 'send_message', {
        to: [to.handle],
        priority: 'normal',
        body,
      });
      assert(r.recipients?.[0]?.status === 'queued', `send failed: ${JSON.stringify(r)}`);
    };

    // (a) one notice, typed into B while it is busy
    await typeLine(page, b.sessionId, `busyq ${BUSY_B_MS}`);
    assert(await until(() => busyOf(page, b.sessionId), 8_000), 'B never read busy');
    await send(b, 'first');

    const noticed = await until(() => notices(b.sessionId).length >= 1, NOTICE_WITHIN_MS);
    assert(noticed, `no notice was submitted in B within ${NOTICE_WITHIN_MS} ms while busy`);
    assert(await busyOf(page, b.sessionId), 'B went idle before its notice was checked');

    // (b) a human draft alone holds C's notice; clearing it releases exactly one
    await typeLine(page, c.sessionId, `busyq ${BUSY_C_MS}`);
    assert(await until(() => busyOf(page, c.sessionId), 8_000), 'C never read busy');
    await keys(page, c.sessionId, 'fix the');
    await send(c, 'second');
    const leaked = await pollUntil(
      () => (notices(c.sessionId).length > 0 ? true : null),
      NEGATIVE_WINDOW_MS,
    );
    assert(
      !leaked,
      `a notice was submitted over the human draft: ${JSON.stringify(notices(c.sessionId))}`,
    );

    await keys(page, c.sessionId, '\x03');
    const released = await until(() => notices(c.sessionId).length >= 1, CLEARED_NOTICE_WITHIN_MS);
    assert(released, 'no notice reached C within 8 s of clearing the draft');
    assert(await busyOf(page, c.sessionId), 'C went idle before the cleared notice');
  },
  { userDataDir: fakeQueueAgentProfile('conduit-mcp-midturn') },
);

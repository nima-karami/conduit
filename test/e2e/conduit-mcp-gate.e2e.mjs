/**
 * conduit-mcp-gate — the notice gate holds on a busy agent, a permission prompt and a human draft,
 * and an idle agent stays output-quiet (spec docs/specs/2026-10-25-conduit-mcp-server.md §2 gate,
 * §7 Gherkin; plan T9.4). Fresh sessions per case, so the 30 s notice spacing never interferes.
 *   (a) B `busy 20000`, A sends urgent: no notice while busy; the host raises "urgent message
 *       waiting for B" (its mcp:state attention item); once idle, exactly one notice.
 *   (b) B shows `permit` (menu at the cursor, `Esc to cancel` 10+ rows below): A sends normal;
 *       for 8 s nothing is submitted and no Enter reaches the prompt.
 *   (c) the human types `fix the` without Enter into B; A sends: no notice for 8 s; Ctrl+C →
 *       a notice within NOTICE_AFTER_IDLE_MS.
 *   (d) plan ruling 5, measured on the fake: an idle B with no traffic never reads busy for 10 s.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  keys,
  mcpState,
  notices,
  openFake,
  records,
  sleep,
  tapMcp,
  URGENT_NOTICE,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario, typeLine } from './harness.mjs';

// Test budgets, derived from the product's clocks rather than guessed: once B's output stops, the
// activity tracker reads idle after its busy window (1.5 s), the gate wants 3 s of output quiet
// (IDLE_QUIET_MS), the notifier ticks every 0.5 s, and the notice is text + 120 ms gap + Enter.
// The slack covers the scenario's own polling and a loaded runner.
const BUSY_WINDOW_MS = 1_500;
const IDLE_QUIET_MS = 3_000;
const TICK_MS = 500;
const SUBMIT_GAP_MS = 120;
const SLACK_MS = 5_000;
const NOTICE_AFTER_IDLE_MS = BUSY_WINDOW_MS + IDLE_QUIET_MS + TICK_MS + SUBMIT_GAP_MS + SLACK_MS;
/** Long enough that the urgent send and its attention item land well inside the busy run. */
const BUSY_MS = 20_000;

const squash = (s) => s.replace(/\s/g, '');
const busyOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id)?.busy === true, sid);

await runScenario(
  'conduit-mcp-gate',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-gate-'));
    const pair = async (label) => {
      const a = await openFake(page, work);
      const b = await openFake(page, work);
      log(`${label}: A=${a.handle} B=${b.handle}`);
      await sleep(4_000);
      return { a, b };
    };
    const send = async (a, b, priority) => {
      const r = await callTool(page, a.sessionId, 'send_message', {
        to: [b.handle],
        priority,
        body: `gate check ${priority}`,
      });
      assert(r.recipients?.[0]?.status === 'queued', `send failed: ${JSON.stringify(r)}`);
    };
    const gateOf = async (b) => (await mcpState(page))?.sessions?.[b.sessionId]?.gate;

    // (a) busy
    {
      const { a, b } = await pair('busy');
      await typeLine(page, b.sessionId, `busy ${BUSY_MS}`);
      assert(await until(() => busyOf(page, b.sessionId), 5_000), 'B never read busy');
      const busyFrom = Date.now();
      await send(a, b, 'urgent');
      const raised = await until(async () => {
        const st = await mcpState(page);
        return (st?.attention ?? []).some(
          (i) => i.reason === 'urgent-waiting' && i.handle === b.handle,
        );
      }, 5_000);
      assert(raised, `no "urgent message waiting for ${b.handle}" attention while busy`);
      // B's output runs BUSY_MS from before busyFrom; no notice may land inside it.
      while (Date.now() - busyFrom < BUSY_MS - 500) {
        assert(notices(b.sessionId).length === 0, 'a notice was typed while B was busy');
        await sleep(250);
      }
      const noticed = await until(() => notices(b.sessionId).length > 0, NOTICE_AFTER_IDLE_MS);
      assert(noticed, `no notice after B went idle (gate: ${await gateOf(b)})`);
      const got = notices(b.sessionId);
      assert(squash(got[0].line) === squash(URGENT_NOTICE), `urgent notice text: ${got[0].line}`);
      await sleep(2_000);
      assert(notices(b.sessionId).length === 1, 'more than one notice after idle');
    }

    // (b) permission prompt far below the cursor
    {
      const { a, b } = await pair('prompt');
      await typeLine(page, b.sessionId, 'permit');
      await sleep(4_000);
      const inputsBefore = records(b.sessionId, 'INPUT').length;
      await send(a, b, 'normal');
      await sleep(8_000);
      const inputs = records(b.sessionId, 'INPUT');
      assert(
        inputs.length === inputsBefore,
        `something was submitted at the prompt: ${JSON.stringify(inputs.slice(inputsBefore))}`,
      );
      const enters = records(b.sessionId, 'PROMPT-ENTER');
      assert(enters.length === 0, 'an Enter reached the permission prompt');
      const gate = await gateOf(b);
      assert(gate === 'blocking-prompt', `gate reason: ${gate}`);
    }

    // (c) human draft
    {
      const { a, b } = await pair('draft');
      await keys(page, b.sessionId, 'fix the');
      await send(a, b, 'normal');
      await sleep(8_000);
      assert(notices(b.sessionId).length === 0, 'a notice was typed over the draft');
      await keys(page, b.sessionId, '\x03');
      const noticed = await until(() => notices(b.sessionId).length > 0, NOTICE_AFTER_IDLE_MS);
      assert(
        noticed,
        `no notice within ${NOTICE_AFTER_IDLE_MS} ms of Ctrl+C (gate: ${await gateOf(b)})`,
      );
    }

    // (d) ruling 5: idle stays output-quiet
    {
      const b = await openFake(page, work);
      await sleep(4_000);
      const from = Date.now();
      let sawBusy = false;
      while (Date.now() - from < 10_000) {
        if (await busyOf(page, b.sessionId)) sawBusy = true;
        await sleep(200);
      }
      log(`ruling 5 (fake): idle ${b.handle} read busy within 10 s: ${sawBusy}`);
      assert(!sawBusy, 'an idle fake agent read busy: idle output is not quiet');
    }
  },
  { userDataDir: fakeAgentProfile('conduit-mcp-gate') },
);

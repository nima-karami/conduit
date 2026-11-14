/**
 * asks-no-window: a waiting tool-policy ask outlives the app (spec docs/specs/2026-11-14-user-input-requests.md
 * REQ-D21c, §9 "An ask with no window open waits in the tray"; plan Slice 5). The app quits while
 * an attach_folder ask (when: always) waits; the server keeps it past the old 5 s ui_unavailable
 * deny, counts it for the tray (`mcp.waitingAsks`), and the call ends with approval_timeout at its
 * budget, never ui_unavailable. Read over a test C2 client, since there is no window to ask.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VERSION } from './auto-resume-helpers.mjs';
import { C2 } from './c2-peer.mjs';
import {
  fakeAgentProfile,
  openFake,
  resultAfter,
  setSessionPolicy,
  startCall,
  tapMcp,
} from './conduit-mcp-helpers.mjs';
import { assert, closeApp, phase, pollUntil, runScenario } from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';

/** Past the removed 5 s grace (APP_GRACE_MS) with room for a loaded runner. */
const PAST_OLD_GRACE_MS = 9_000;
/** The fake's CLI kind gets the smallest ask budget (25 s, call-flow ASK_TIMEOUT_MS), plus slack. */
const BUDGET_END_WITHIN_MS = 40_000;

async function serverClient(userDataDir) {
  const { serverEndpoint } = teardownNames(userDataDir, process.platform, tmpdir());
  let c2 = null;
  const ok = await pollUntil(
    async () => {
      try {
        c2 = await C2.open(serverEndpoint);
        await c2.call('hello', { appVersion: APP_VERSION, generation: SERVER_PROTOCOL_GENERATION });
        return true;
      } catch {
        c2?.close();
        c2 = null;
        return false;
      }
    },
    30_000,
    250,
  );
  assert(ok && c2, 'the server pipe never accepted a hello');
  return c2;
}

await runScenario(
  'asks-no-window',
  async ({ app, page, userDataDir, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'asks-no-window-'));
    const extra = mkdtempSync(join(tmpdir(), 'asks-no-window-extra-'));
    const a = await openFake(page, work);
    await setSessionPolicy(page, a.sessionId, 'attach_folder', { access: 'ask', when: 'always' });

    phase('ask waits, then the app quits');
    const before = await startCall(page, a.sessionId, 'attach_folder', { path: extra });
    await page.locator('.askcard').waitFor({ timeout: 10_000 });
    const quitAt = Date.now();
    await closeApp(app, page);

    const c2 = await serverClient(userDataDir);
    try {
      phase('past the old grace');
      const remaining = PAST_OLD_GRACE_MS - (Date.now() - quitAt);
      await pollUntil(async () => Date.now() - quitAt >= PAST_OLD_GRACE_MS, remaining + 1_000, 250);
      assert(
        (await resultAfter(a.sessionId, before, 0)) === null,
        'the ask ended within the old 5 s grace',
      );
      const snap = await c2.call('events.subscribe', {});
      assert(
        snap.pendingAsks?.some((x) => x.callerSessionId === a.sessionId),
        `the ask is not pending with no app: ${JSON.stringify(snap.pendingAsks)}`,
      );
      assert(snap.mcp?.waitingAsks === 1, `tray input waitingAsks=${snap.mcp?.waitingAsks}`);
      log('still waiting with no app ✓, counted for the tray ✓');

      phase('ends at its budget');
      const ended = await resultAfter(a.sessionId, before, BUDGET_END_WITHIN_MS);
      assert(
        ended?.error?.code === 'approval_timeout',
        `expected approval_timeout, got ${JSON.stringify(ended)}`,
      );
      log('approval_timeout at the budget, never ui_unavailable ✓');
    } finally {
      c2.close();
    }
  },
  { userDataDir: fakeAgentProfile('asks-no-window') },
);

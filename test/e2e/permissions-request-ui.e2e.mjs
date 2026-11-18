import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionId,
  fakeAgentProfile,
  mcpState,
  openFake,
  resultAfter,
  sessions,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, runScenario, showRightView } from './harness.mjs';

const shots = process.env.CONDUIT_SHOTS_DIR;
await runScenario(
  'permissions-request-ui',
  async ({ page, log }) => {
    await tapMcp(page);
    await page.evaluate(() => {
      window.__permissionAsks = [];
      window.agentDeck.subscribe((m) => {
        if (m.type === 'mcp:ask') window.__permissionAsks.push(m);
      });
    });
    const worker = await openFake(page, mkdtempSync(join(tmpdir(), 'permission-worker-')));
    const target = await openFake(page, mkdtempSync(join(tmpdir(), 'permission-target-')));
    await page
      .locator(
        `[data-agent-tree] .session[data-sessionid="${worker.sessionId}"] [data-agent-action="select"]`,
      )
      .click();
    assert(
      await until(async () => (await activeSessionId(page)) === worker.sessionId, 5000),
      'worker not selected',
    );
    phase('real permission ask');
    await page.setViewportSize({ width: 1024, height: 900 });
    const before = await startCall(page, worker.sessionId, 'close_session', {
      session: target.handle,
    });
    await showRightView(page, 'needs');
    const row = page.locator('.needs-list [role="option"]', { hasText: 'close' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.click();
    const body = page.locator('.needs-permission .permissions-request-body');
    await body.waitFor({ timeout: 5000 });
    await body.getByRole('button', { name: 'Allow…' }).click();
    assert((await body.locator('select').count()) === 3, 'grant selector absent');
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, 'permission-23-narrow.png') });
    }
    await body.getByRole('button', { name: 'Cancel' }).click();
    await body.getByRole('button', { name: 'Deny ▾' }).click();
    await body.getByRole('button', { name: 'Deny', exact: true }).click();
    const result = await resultAfter(worker.sessionId, before, 15000);
    assert(
      result?.error?.code === 'denied',
      `denial did not reach the agent: ${JSON.stringify(result)}`,
    );
    log('real permission ask, grant selector and denial ✓');

    phase('expired permission creates only a future grant');
    await page.setViewportSize({ width: 1440, height: 900 });
    const beforeExpired = await startCall(page, worker.sessionId, 'close_session', {
      session: target.handle,
    });
    let askId = null;
    assert(
      await until(async () => {
        const asks = await page.evaluate(() => window.__permissionAsks);
        askId =
          asks.filter((ask) => ask.callerSessionId === worker.sessionId).at(-1)?.askId ?? null;
        return asks.filter((ask) => ask.callerSessionId === worker.sessionId).length >= 2;
      }, 15000),
      'second permission ask did not arrive',
    );
    const expired = await resultAfter(worker.sessionId, beforeExpired, 40000);
    assert(
      expired?.error?.code === 'approval_timeout',
      `ask did not expire: ${JSON.stringify(expired)}`,
    );
    assert(
      (await sessions(page)).some((s) => s.id === target.sessionId),
      'expired call closed target',
    );
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const expiredRow = page.locator('.needs-list [role="option"]', { hasText: 'Expired' }).first();
    await expiredRow.waitFor({ timeout: 15000 });
    await expiredRow.click();
    const lateBody = page.locator('.needs-permission .permissions-request-body');
    await lateBody.getByRole('button', { name: 'Allow next time' }).click();
    await lateBody.getByLabel('For', { exact: true }).selectOption('1h');
    if (shots) await page.screenshot({ path: join(shots, 'permission-06-expired.png') });
    await lateBody.getByRole('button', { name: 'Create grant' }).click();
    assert(
      await until(
        async () =>
          (await mcpState(page)).policy.grants.some(
            (grant) => grant.requestId === askId && grant.state === 'active',
          ),
        15000,
      ),
      'late grant was not created',
    );
    assert(
      (await sessions(page)).some((s) => s.id === target.sessionId),
      'late grant ran the expired call',
    );
    assert(
      await until(async () => (await expiredRow.count()) === 1, 10000),
      'expired request disappeared from History after the grant',
    );
    log('expired ask remains in History; next-time grant leaves original target open ✓');
  },
  { userDataDir: fakeAgentProfile('permissions-request-ui') },
);

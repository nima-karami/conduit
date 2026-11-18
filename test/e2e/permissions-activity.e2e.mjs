import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-activity');
const { env } = isolatedHome(userDataDir);
const callerPath = join(userDataDir, 'caller');
const targetPath = join(userDataDir, 'target');
mkdirSync(callerPath);
mkdirSync(targetPath);

const capture = async (page, name) => {
  const directory = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, name) });
  }
};

async function ownerCommand(page, message) {
  return page.evaluate(
    (command) =>
      new Promise((resolve, reject) => {
        const requestId = Date.now();
        const timer = setTimeout(() => {
          off();
          reject(new Error('No owner policy receipt'));
        }, 5000);
        const off = window.agentDeck.subscribe((reply) => {
          if (reply.type !== 'mcp:policyEditResult' || reply.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          resolve(reply.result);
        });
        window.agentDeck.post({ ...command, requestId });
      }),
    message,
  );
}

await runScenario(
  'permissions-activity',
  async ({ page, log }) => {
    await tapMcp(page);
    const caller = await openFake(page, callerPath);
    const target = await openFake(page, targetPath);
    const expectedToken = (await mcpState(page)).policy.editToken;
    const point = { kind: 'session', sessionId: caller.sessionId };
    const assignment = {
      profileId: 'lead',
      onScreenOnly: false,
      exceptions: [
        {
          tool: 'close_session',
          scope: { kind: 'anywhere' },
          rule: { decision: 'deny', when: 'always', reach: 'any' },
        },
      ],
    };
    const saved = await ownerCommand(page, {
      type: 'mcp:saveAssignment',
      point,
      assignment,
      expectedToken,
    });
    assert(saved.ok === true, `could not prepare exact deny: ${JSON.stringify(saved)}`);
    const result = await callTool(page, caller.sessionId, 'close_session', {
      session: target.handle,
    });
    assert(result?.error?.code === 'tool_disabled', JSON.stringify(result));
    await capture(page, '08-action-refused.png');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.locator('.settings');
    await settings.getByRole('button', { name: 'Permissions', exact: true }).click();
    await settings.getByRole('button', { name: 'Activity', exact: true }).click();
    const activity = page.getByRole('main', { name: 'Permissions Activity' });
    await activity.waitFor({ timeout: 7000 });
    const denial = activity
      .getByRole('row')
      .filter({
        has: page.getByRole('cell', { name: 'close_session', exact: true }),
      })
      .first();
    try {
      await denial.waitFor({ timeout: 5000 });
    } catch (error) {
      log(`Activity shows: ${(await activity.innerText()).slice(0, 1200)}`);
      await capture(page, '09-activity-failed.png');
      throw error;
    }
    await denial.getByRole('button', { name: 'Why' }).click();
    const why = activity.getByRole('complementary', { name: 'Why was this denied?' });
    await why.waitFor();
    await why
      .getByText(/Deny exception/)
      .first()
      .waitFor();
    await capture(page, '09-why-denied.png');

    await why.getByRole('button', { name: 'Add exception' }).click();
    await settings.getByRole('heading', { name: /Edit assignment/ }).waitFor();
    const check = settings.getByRole('heading', { name: 'Check a request' });
    await check.waitFor();
    const checker = settings.getByRole('region', { name: 'Check a request' });
    await checker.getByLabel('Session', { exact: true }).selectOption(caller.sessionId);
    await checker.getByLabel('Target session', { exact: true }).selectOption(target.sessionId);
    await checker.getByRole('button', { name: 'Check request', exact: true }).click();
    const previewOutput = checker.getByRole('status').locator('p');
    await previewOutput.waitFor({ timeout: 12_000 });
    const prediction = await previewOutput.innerText();
    assert(
      prediction.includes('ALLOW') &&
        prediction.includes('Runtime conditions have not been evaluated'),
      `unexpected policy preview: ${prediction}`,
    );
    const replay = settings.getByRole('region', { name: 'Seven-day policy replay' });
    await replay.getByRole('button', { name: 'Compare Activity' }).click();
    const replayOutput = replay.getByText(/1 changed of [1-9][0-9]* evaluated/);
    await replayOutput.waitFor({ timeout: 12_000 });
    await check.scrollIntoViewIfNeeded();
    await capture(page, '12-exception-from-event.png');
    await settings.getByRole('button', { name: 'Close settings' }).click();

    await why.getByRole('button', { name: 'Allow this once' }).click();
    await why.getByText('The agent may retry this target once.').waitFor();
    const targetRow = page.locator(`.session[data-sessionid="${target.sessionId}"]`);
    assert(await targetRow.count(), 'issuing an override unexpectedly dispatched the close');
    const retry = await callTool(page, caller.sessionId, 'close_session', {
      session: target.handle,
    });
    assert(retry?.closed === target.sessionId, `agent retry: ${JSON.stringify(retry)}`);
    await targetRow.waitFor({ state: 'detached' });
    await capture(page, '10-action-retried.png');
    assert(
      await until(
        async () => (await mcpState(page)).policy.sessions[caller.sessionId]?.profileId === 'lead',
        5000,
      ),
      'Activity review mutated the assignment',
    );
    log('real deny, truthful Why, exact exception draft, and one-use agent retry verified');
  },
  { userDataDir, env, openFolder: false },
);

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedHome } from './conduit-mcp-helpers.mjs';
import { assert, hcTerminalOf, pollUntil, profileDir, runScenario, tapBridge } from './harness.mjs';

const userDataDir = profileDir('conversation-resume-refusal');
const { env } = isolatedHome(userDataDir);
const home = join(userDataDir, 'work');
mkdirSync(home);
const id = 'resume-refusal-fixture';
writeFileSync(
  join(userDataDir, 'agents.json'),
  JSON.stringify([
    {
      id: 'opencode',
      label: 'OpenCode fixture',
      command: process.execPath,
      args: ['-i'],
    },
  ]),
);
writeFileSync(
  join(userDataDir, 'sessions.json'),
  JSON.stringify({
    version: 1,
    sessions: [
      {
        id,
        name: 'Existing conversation',
        home,
        roots: [],
        agentId: 'opencode',
        lastGeneration: 1,
      },
    ],
  }),
);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({
    version: 1,
    settings: { restoreSessions: true, autoRelaunchStale: true },
  }),
);

await runScenario(
  'conversation-resume-refusal',
  async ({ page }) => {
    const refused = page.getByRole('heading', { name: 'Could not resume conversation' });
    await refused.waitFor({ state: 'visible' });
    assert(!hcTerminalOf(userDataDir, id)?.address, 'A fresh process launched without consent');
    await tapBridge(page);
    const previous = await page.evaluate(
      (sessionId) => window.__sessions.find((s) => s.id === sessionId)?.startRefusal?.refusalId,
      id,
    );
    await page.getByRole('button', { name: 'Retry', exact: true }).press('Enter');
    await page.waitForFunction(
      ({ sessionId, previousRefusal }) => {
        const token = window.__sessions.find((s) => s.id === sessionId)?.startRefusal?.refusalId;
        return !!token && token !== previousRefusal;
      },
      { sessionId: id, previousRefusal: previous },
    );
    await refused.waitFor({ state: 'visible' });
    assert(!hcTerminalOf(userDataDir, id)?.address, 'Retry started a fresh process');
    await page.getByRole('button', { name: 'Start new conversation', exact: true }).press('Enter');
    assert(
      await pollUntil(() => !!hcTerminalOf(userDataDir, id)?.address, 15_000),
      'No new process after explicit start',
    );
    await refused.waitFor({ state: 'hidden' });
  },
  { userDataDir, env },
);

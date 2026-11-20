import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedHome } from './conduit-mcp-helpers.mjs';
import { assert, hcTerminalOf, pollUntil, profileDir, runScenario, tapBridge } from './harness.mjs';

const userDataDir = profileDir('conversation-resume-refusal');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
const home = realpathSync.native(work);
const storageHome = join(userDataDir, 'claude-config');
mkdirSync(join(storageHome, 'projects'), { recursive: true });
env.CLAUDE_CONFIG_DIR = storageHome;

const keys = generateKeyPairSync('ed25519');
const raw = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url');
const machineId = `m-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
mkdirSync(join(userDataDir, 'network'));
writeFileSync(
  join(userDataDir, 'network', 'identity.json'),
  JSON.stringify({
    version: 1,
    serverKey: {
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    },
    ownerKey: null,
  }),
  { mode: 0o600 },
);

const windows = process.platform === 'win32';
const launcher = join(userDataDir, windows ? 'claude.cmd' : 'claude');
writeFileSync(
  launcher,
  windows ? `@"${process.execPath}" -i\r\n` : `#!/bin/sh\nexec "${process.execPath}" -i\n`,
  { mode: 0o755 },
);
const id = 'resume-refusal-fixture';
const openCodeId = 'resume-opencode-fixture';
writeFileSync(
  join(userDataDir, 'agents.json'),
  JSON.stringify([
    { id: 'claude', label: 'Claude fixture', command: launcher, args: [] },
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
        agentId: 'claude',
        lastGeneration: 1,
        conversationRef: {
          version: 1,
          adapterId: 'claude',
          conversationId: '9e997f63-14d6-4a43-8c33-98139747de2d',
          scope: { cwd: home, storageHome, machineId },
          capturedAt: { generation: 1, launchId: 'a'.repeat(32) },
        },
      },
      {
        id: openCodeId,
        name: 'OpenCode conversation',
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
    await tapBridge(page);
    const select = (sessionId) => page.locator(`.session[data-sessionid="${sessionId}"]`).click();
    await select(id);
    const refused = page.getByRole('heading', { name: 'Could not resume conversation' });
    await refused.waitFor({ state: 'visible' });
    assert(!hcTerminalOf(userDataDir, id)?.address, 'A fresh process launched without consent');
    await page.getByText('The agent could not find the saved conversation.').waitFor();
    await page.waitForFunction(
      (sessionId) => window.__sessions.some((s) => s.id === sessionId && !!s.startRefusal),
      id,
    );
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
    await select(openCodeId);
    const openCodePane = page.locator(`.termhost[data-sessionid="${openCodeId}"]`);
    await openCodePane.getByText('Started a new conversation', { exact: true }).waitFor();
    assert(
      await pollUntil(() => !!hcTerminalOf(userDataDir, openCodeId)?.address, 15_000),
      'OpenCode did not relaunch without a saved conversation',
    );
    assert(!(await refused.isVisible()), 'OpenCode displayed a resume refusal');
  },
  { userDataDir, env },
);

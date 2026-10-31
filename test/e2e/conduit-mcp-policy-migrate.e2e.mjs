/**
 * conduit-mcp-policy-migrate — a v0.50 settings file migrates to tool policies (spec
 * docs/specs/2026-10-30-conduit-mcp-tool-policy.md §3.1; plan T3.4). The profile starts with
 * v0.50's `mcpTools` switches and no `mcpToolPolicy`:
 *   - open_session `true` → On · Always: it runs from an off-screen caller without a card;
 *   - open_file `false` (a control tool) → its new default, On · While on screen: refused off screen;
 *   - send_message `false` (a messaging tool, v0.50 default on) → Off: refused;
 *   - the next settings write drops `mcpTools` and stores the migrated policy.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  activeSessionId,
  callTool,
  FAKE_AGENT_ID,
  fakeAgentProfile,
  openFake,
  sessions,
  setMessaging,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;

const userDataDir = fakeAgentProfile('policy-migrate');
const settingsFile = join(userDataDir, 'settings.json');
writeFileSync(
  settingsFile,
  JSON.stringify({
    version: 1,
    settings: {
      conduitMcp: true,
      mcpTools: {
        list_sessions: true,
        send_message: false,
        read_inbox: true,
        read_attachment: true,
        open_session: true,
        open_terminal: false,
        open_file: false,
      },
    },
  }),
);

await runScenario(
  'conduit-mcp-policy-migrate',
  async ({ page, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-policy-migrate-${label}-`));
    const dirA = temp('a');
    const dirB = temp('b');
    const target = temp('target');
    writeFileSync(join(dirA, 'fixture.txt'), 'migrate fixture\n');

    phase('setup');
    const a = await openFake(page, dirA);
    const b = await openFake(page, dirB);
    await page.locator(`.session[data-sessionid="${b.sessionId}"]`).click();
    assert(
      await until(async () => (await activeSessionId(page)) === b.sessionId, 5_000),
      'B never became active',
    );

    phase('enabled tool → On · Always');
    const opened = await callTool(page, a.sessionId, 'open_session', {
      path: target,
      agent: FAKE_AGENT_ID,
      focus: false,
    });
    assert(opened?.session_id, `open_session: ${JSON.stringify(opened)}`);
    assert((await page.locator('.askcard').count()) === 0, 'a migrated On · Always tool asked');
    log('open_session true → On · Always ✓');

    phase('control false → new default');
    const file = await callTool(page, a.sessionId, 'open_file', { path: 'fixture.txt' });
    assert(errCode(file) === 'caller_not_visible', `open_file: ${JSON.stringify(file)}`);
    log('open_file false → On · While on screen ✓');

    phase('messaging false → Off');
    const sent = await callTool(page, a.sessionId, 'send_message', { to: [b.handle], body: 'x' });
    assert(errCode(sent) === 'tool_disabled', `send_message: ${JSON.stringify(sent)}`);
    log('send_message false → Off ✓');

    phase('old key gone on write');
    await setMessaging(page, true);
    const stored = () => JSON.parse(readFileSync(settingsFile, 'utf8')).settings;
    const migrated = (s) =>
      !('mcpTools' in s) &&
      isDeepStrictEqual(s.mcpToolPolicy?.open_session, {
        access: 'on',
        when: 'always',
        move: 'yes',
      }) &&
      isDeepStrictEqual(s.mcpToolPolicy?.send_message, { access: 'off' });
    assert(
      await until(() => migrated(stored()), 10_000),
      `settings.json after a write: ${JSON.stringify(stored())}`,
    );
    log('settings.json holds mcpToolPolicy, no mcpTools ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirA, dirB, target]) await removeDir(d, { budgetMs: 10_000 });
  },
  { userDataDir },
);

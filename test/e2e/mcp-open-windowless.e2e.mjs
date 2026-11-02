/**
 * mcp-open-windowless — an agent's MCP `open_session`, with the tool's policy On (always), creates
 * the session while the app has no window at all (program W8): the server owns sessions and MCP,
 * so the open needs no renderer. Closing the last window quits the app, so "windowless" is the
 * app quit while its agents and server keep running (architecture F4).
 *   - a fake MCP agent's open_session layer is set to On / always, then the app quits;
 *   - the agent, typed into through its own hc terminal, calls open_session for a new folder;
 *   - the call succeeds with a session id;
 *   - relaunched on the same profile, the app shows that session, rooted at the folder, live.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_AGENT_ID,
  fakeAgentProfile,
  openFake,
  records,
  sessions,
  setSessionPolicy,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import {
  assert,
  closeApp,
  hcTerminalOf,
  launchApp,
  ownHc,
  phase,
  removeDir,
  runScenario,
  shutdownApp,
} from './harness.mjs';

const sameDir = (a, b) =>
  realpathSync.native(a).replace(/\\/g, '/').toLowerCase() ===
  realpathSync.native(b).replace(/\\/g, '/').toLowerCase();

await runScenario(
  'mcp-open-windowless',
  async ({ app, page, userDataDir, log }) => {
    await tapMcp(page);
    const dirA = mkdtempSync(join(tmpdir(), 'conduit-windowless-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'conduit-windowless-b-'));

    phase('agent with open_session On / always');
    const main = await openFake(page, dirA);
    await setSessionPolicy(page, main.sessionId, 'open_session', { access: 'on', when: 'always' });
    const terminal = hcTerminalOf(userDataDir, main.sessionId);
    assert(terminal?.address, `no live hc terminal for ${main.sessionId}`);

    phase('quit: no window, no app');
    await closeApp(app, page);
    await sleep(1_500);
    assert(
      hcTerminalOf(userDataDir, main.sessionId)?.address === terminal.address,
      'the agent did not survive the quit',
    );

    phase('open_session while windowless');
    const before = records(main.sessionId, 'RESULT').length;
    const call = `call open_session ${JSON.stringify({ path: dirB.replace(/\\/g, '/'), agent: FAKE_AGENT_ID, focus: true })}`;
    const sent = ownHc(userDataDir, ['send', terminal.address, call], { timeout: 60_000 });
    assert(sent.status === 0, `hc send: exit ${sent.status}: ${sent.out.slice(0, 300)}`);
    assert(
      await until(() => records(main.sessionId, 'RESULT').length > before, 30_000),
      `the agent never got an open_session result: ${JSON.stringify(records(main.sessionId, 'CALL'))}`,
    );
    const result = records(main.sessionId, 'RESULT').at(-1).result;
    log(`open_session while windowless: ${JSON.stringify(result)}`);
    assert(result?.session_id && !result.error, `open_session failed: ${JSON.stringify(result)}`);

    phase('relaunch: the session appears');
    let second = null;
    try {
      second = await launchApp({ userDataDir });
      await tapMcp(second.page);
      assert(
        await until(
          async () => (await sessions(second.page)).some((s) => s.id === result.session_id),
          20_000,
        ),
        `the windowless open is missing after the relaunch: ${JSON.stringify((await sessions(second.page)).map((s) => s.id))}`,
      );
      const created = (await sessions(second.page)).find((s) => s.id === result.session_id);
      assert(sameDir(created.home, dirB), `home ${created.home} ≠ ${dirB}`);
      assert(
        await until(async () => {
          const s = (await sessions(second.page)).find((x) => x.id === result.session_id);
          return s?.status === 'running';
        }, 20_000),
        `the opened session is not running: ${JSON.stringify(created)}`,
      );
      log('the windowless open is shown after the relaunch ✓');

      phase('cleanup');
      for (const s of await sessions(second.page))
        await second.page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
      await until(async () => (await sessions(second.page)).length === 0, 15_000);
      await closeApp(second.app, second.page);
      for (const d of [dirA, dirB]) await removeDir(d, { budgetMs: 10_000 });
    } finally {
      if (second) await shutdownApp(second.app, second.page);
    }
  },
  { userDataDir: fakeAgentProfile('windowless') },
);

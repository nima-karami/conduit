import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  clickAskAnswer,
  fakeAgentProfile,
  openFake,
  pathWith,
  resultAfter,
  sessions,
  setSessionPolicy,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, REPO, removeDir, runScenario, windowsOnlyScenario } from './harness.mjs';

await windowsOnlyScenario('conduit-mcp-flexible-agents', 'PowerShell agent');

await runScenario(
  'conduit-mcp-flexible-agents',
  async ({ page, log }) => {
    await tapMcp(page);
    const dir = mkdtempSync(join(tmpdir(), 'conduit-mcp-flexible-'));
    try {
      const caller = await openFake(page, dir);
      await setSessionPolicy(page, caller.sessionId, 'open_session', { when: 'always' });
      await setSessionPolicy(page, caller.sessionId, 'send_input', { when: 'always' });
      await setSessionPolicy(page, caller.sessionId, 'read_screen', { when: 'always' });

      phase('open bare command');
      const before = await startCall(page, caller.sessionId, 'open_session', {
        agent: 'kirofix',
        path: dir,
        message: 'hello',
      });
      await page.locator('.askcard').waitFor({ timeout: 10_000 });
      await clickAskAnswer(page, 'approve');
      const opened = await resultAfter(caller.sessionId, before, 15_000);
      await page.locator('.askcard').waitFor({ state: 'detached', timeout: 5_000 });
      assert(/^kirofix-\d+$/.test(opened?.handle ?? ''), `handle: ${JSON.stringify(opened)}`);
      assert(typeof opened?.session_id === 'string', `session_id: ${JSON.stringify(opened)}`);
      assert(typeof opened?.message?.id === 'string', `message: ${JSON.stringify(opened)}`);
      const listed = await callTool(page, caller.sessionId, 'list_sessions');
      const entry = listed.sessions?.find((s) => s.handle === opened.handle);
      assert(
        entry?.session_id === opened.session_id && entry?.messageable === false,
        `list_sessions: ${JSON.stringify(listed)}`,
      );

      await page.locator(`.session[data-sessionid="${opened.session_id}"]`).click();
      const hasOutput = (text) =>
        page.evaluate(({ id, text }) => (window.__capBy?.[id] ?? '').includes(text), {
          id: opened.session_id,
          text,
        });
      assert(await until(() => hasOutput('KIRO READY'), 30_000), 'fixture never became ready');
      let screen = await callTool(page, caller.sessionId, 'read_screen', {
        session: opened.handle,
      });
      assert(
        screen.rows?.some((row) => row.includes('KIRO READY')),
        `read_screen: ${JSON.stringify(screen)}`,
      );
      phase('send input');
      const inputBefore = await startCall(page, caller.sessionId, 'send_input', {
        session: opened.handle,
        text: 'ping',
        submit: true,
      });
      await page.locator('.askcard').waitFor({ timeout: 10_000 });
      await clickAskAnswer(page, 'approve');
      const sent = await resultAfter(caller.sessionId, inputBefore, 15_000);
      assert(
        sent?.session === opened.handle && sent.sent_chars === 4 && sent.keys_sent === 0,
        `send_input: ${JSON.stringify(sent)}`,
      );
      await page.locator(`.session[data-sessionid="${opened.session_id}"]`).click();
      assert(await until(() => hasOutput('GOT:ping'), 30_000), 'fixture never received ping');
      screen = await callTool(page, caller.sessionId, 'read_screen', { session: opened.handle });
      assert(
        screen.rows?.some((row) => row.includes('GOT:ping')),
        `input screen: ${JSON.stringify(screen)}`,
      );
      phase('refusals');
      const refused = await callTool(page, caller.sessionId, 'open_session', {
        agent: 'powershell',
        path: dir,
      });
      assert(
        refused?.error?.code === 'invalid_args' && refused.error.hint,
        `refused: ${JSON.stringify(refused)}`,
      );
      const unknown = await callTool(page, caller.sessionId, 'read_screen', {
        session: 'missing-999',
      });
      assert(
        unknown?.error?.code === 'unknown_session' && Array.isArray(unknown.error.valid),
        `unknown: ${JSON.stringify(unknown)}`,
      );
      log('bare command, screen, input and refusals verified');
    } finally {
      for (const s of await sessions(page)) {
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
      }
      assert(
        await until(async () => (await sessions(page)).length === 0, 15_000),
        'sessions survived kill',
      );
      await removeDir(dir, { budgetMs: 10_000 });
    }
  },
  {
    userDataDir: fakeAgentProfile('flexible-agents'),
    env: pathWith(join(REPO, 'test', 'e2e', 'fixtures', 'kiro-fixture')),
  },
);

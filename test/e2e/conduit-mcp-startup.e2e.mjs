import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  openFake,
  records,
  sessions,
  setSessionPolicy,
  sleep,
  startupAgentProfile,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, removeDir, runScenario } from './harness.mjs';

await runScenario(
  'conduit-mcp-startup',
  async ({ page, log }) => {
    await tapMcp(page);
    const dir = mkdtempSync(join(tmpdir(), 'conduit-startup-'));
    try {
      const lead = await openFake(page, dir);
      await setSessionPolicy(page, lead.sessionId, 'open_session', {
        access: 'on',
        when: 'always',
      });
      await setSessionPolicy(page, lead.sessionId, 'read_screen', { when: 'always' });
      await setSessionPolicy(page, lead.sessionId, 'send_input', {
        access: 'on',
        when: 'always',
      });
      const opened = await callTool(page, lead.sessionId, 'open_session', {
        agent: 'e2e-fake-startup',
        path: dir,
        label: 'Startup helper',
        focus: false,
        message: 'Do the task',
      });
      assert(opened.startup === 'waiting_at_prompt', `startup: ${JSON.stringify(opened)}`);
      assert(
        opened.screen_excerpt?.includes('Startup approval required'),
        `screen: ${JSON.stringify(opened)}`,
      );
      const listed = await callTool(page, lead.sessionId, 'list_sessions');
      const child = listed.sessions?.find((s) => s.handle === opened.handle);
      assert(child?.label === 'Startup helper', `title replaced label: ${JSON.stringify(child)}`);
      const got = await until(
        () =>
          records(lead.sessionId, 'INBOX').some((r) =>
            r.result.messages?.some(
              (m) => m.from === opened.handle && m.body.includes('Startup approval required'),
            ),
          ),
        50_000,
      );
      assert(got, 'lead did not receive the startup follow-up');
      await sleep(4_000);
      const reports = records(lead.sessionId, 'INBOX')
        .flatMap((r) => r.result.messages ?? [])
        .filter((m) => m.from === opened.handle && m.body.includes('Startup approval required'));
      assert(reports.length === 1, `duplicate follow-up: ${JSON.stringify(reports)}`);
      const sent = await callTool(page, lead.sessionId, 'send_input', {
        session: opened.handle,
        text: '1',
      });
      assert(!sent.error, `approval input: ${JSON.stringify(sent)}`);
      assert(
        await until(
          () =>
            records(opened.session_id, 'INBOX').some((r) =>
              r.result.messages?.some((m) => m.body.includes('Do the task')),
            ),
          30_000,
        ),
        'first task was not delivered after approval',
      );
      log('prompt, retained label, and follow-up observed');
    } finally {
      for (const s of await sessions(page))
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
      assert(
        await until(async () => (await sessions(page)).length === 0, 15_000),
        'sessions survived cleanup',
      );
      await removeDir(dir, { budgetMs: 10_000 });
    }
  },
  { userDataDir: startupAgentProfile('conduit-mcp-startup') },
);

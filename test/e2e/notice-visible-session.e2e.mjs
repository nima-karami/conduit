/**
 * notice-visible-session — an agent's message to a session the person is looking at is announced
 * in that session's pane (program W8): the notice is typed by the server's PtyWriter into the
 * recipient's hc terminal, so the app sees it only as the program's own echo through its observer.
 *   - fake MCP agents A and B; B is the active, on-screen session;
 *   - A sends B a message; B's program receives exactly the fixed notice line;
 *   - B's pane shows that notice (the fake echoes typed keys after its prompt).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionId,
  callTool,
  fakeAgentProfile,
  NOTICE,
  notices,
  openFake,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, logicalLines, phase, removeDir, runScenario } from './harness.mjs';

const squash = (s) => s.replace(/\s/g, '');
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';

await runScenario(
  'notice-visible-session',
  async ({ page, log }) => {
    await tapMcp(page);
    await page.evaluate(() => {
      window.__terms = {};
    });
    const work = mkdtempSync(join(tmpdir(), 'conduit-notice-visible-'));

    phase('two agents, B on screen');
    const a = await openFake(page, work);
    const b = await openFake(page, work);
    await page.locator(`.session[data-sessionid="${b.sessionId}"]`).click();
    assert(
      await until(async () => (await activeSessionId(page)) === b.sessionId, 5_000),
      'B never became active',
    );
    assert(
      await until(
        () =>
          page.evaluate((id) => (window.__terms?.[id]?.element?.offsetWidth ?? 0) > 0, b.sessionId),
        10_000,
      ),
      "B's pane is not on screen",
    );
    // B idle at its prompt: past the settle window and the idle quiet.
    await sleep(4_000);

    phase('A messages B');
    const sent = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      priority: 'normal',
      kind: 'request',
      subject: 'ping',
      body: 'hello from A',
    });
    assert(!sent.error, `send_message failed: ${JSON.stringify(sent)}`);
    assert(
      await until(() => notices(b.sessionId).length > 0, 10_000),
      'no notice was submitted in B',
    );
    const first = notices(b.sessionId)[0];
    assert(squash(first.line) === squash(NOTICE), `notice text: ${first.line}`);
    log('the program received the notice ✓');

    phase('pane');
    assert(
      await until(
        async () => squash(await paneText(page, b.sessionId)).includes(squash(NOTICE)),
        10_000,
      ),
      `B's pane never showed the notice: ${JSON.stringify((await paneText(page, b.sessionId)).slice(-600))}`,
    );
    log("the notice is in B's pane ✓");

    phase('cleanup');
    for (const id of [a.sessionId, b.sessionId])
      await page.evaluate((s) => window.agentDeck.post({ type: 'kill', id: s }), id);
    await until(
      () =>
        page.evaluate(() => (window.__sessions || []).every((s) => !s.agentId?.includes('fake'))),
      15_000,
    );
    await removeDir(work, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('notice-visible') },
);

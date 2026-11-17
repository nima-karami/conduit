import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  tapMcp,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-ui');
const { env } = isolatedHome(userDataDir);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true } }),
);

async function activity(page, query) {
  const result = await page.evaluate(
    ({ query }) =>
      new Promise((resolve) => {
        const requestId = Math.floor(Math.random() * 1_000_000_000);
        const timer = setTimeout(() => {
          off();
          resolve(null);
        }, 10_000);
        const off = window.agentDeck.subscribe((message) => {
          if (message.type !== 'mcp:activity' || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          resolve(message.page);
        });
        window.agentDeck.post({ type: 'mcp:activity:get', requestId, query });
      }),
    { query },
  );
  assert(result !== null, 'Activity query did not answer');
  return result;
}

await runScenario(
  'permissions-ui',
  async ({ page, log }) => {
    await tapMcp(page);
    const first = await openFake(page, mkdtempSync(join(tmpdir(), 'permissions-ui-first-')));
    const second = await openFake(page, mkdtempSync(join(tmpdir(), 'permissions-ui-second-')));
    const state = await mcpState(page);
    assert(
      state.policy.profiles.some(
        (profile) => profile.id === 'lead' && profile.rules.open_terminal.decision === 'allow',
      ),
      'full built-in rules are missing',
    );
    assert(Array.isArray(state.policy.assignments), 'full assignments missing');

    const body = 'permissions-ui-private-body-4382';
    const result = await callTool(page, first.sessionId, 'send_message', { to: ['you'], body });
    assert(!result?.error, `send_message failed: ${JSON.stringify(result)}`);
    await callTool(page, first.sessionId, 'list_sessions', {});
    await callTool(page, second.sessionId, 'list_sessions', {});
    const all = await activity(page, { sessionId: first.sessionId });
    assert(all.error === null, `Activity failed: ${all.error}`);
    assert(all.rows.length > 1, 'real host Activity rows missing');
    assert(
      all.rows.every((row) => row.principal.sessionId === first.sessionId),
      'session filter leaked another session',
    );
    assert(
      all.rows.some((row) => row.action === 'list_sessions' && row.count > 0),
      'pending hourly reads missing',
    );
    assert(
      all.rows.some((row) => row.action === 'send_message'),
      'persisted decided action missing',
    );
    assert(!JSON.stringify(all).includes(body), 'Activity exposed a message body');
    log('real persisted action and pending count queried; session filter and privacy verified');

    const one = await activity(page, { sessionId: first.sessionId, limit: 1 });
    assert(
      one.rows.length === 1 && typeof one.next === 'string',
      'first page has no stable cursor',
    );
    const next = await activity(page, { sessionId: first.sessionId, limit: 1, before: one.next });
    assert(
      next.error === null && next.rows.length === 1 && next.rows[0].id !== one.rows[0].id,
      'cursor duplicated or skipped Activity',
    );
    const none = await activity(page, { sessionId: 'does-not-exist' });
    assert(none.error === null && none.rows.length === 0, 'empty filter fabricated rows');
    const invalid = await activity(page, { limit: 201 });
    assert(
      typeof invalid.error === 'string' && invalid.rows.length === 0,
      'host accepted invalid Activity limit',
    );
    log('pagination, empty filter and host validation verified');
  },
  { userDataDir, env },
);

/**
 * conduit-mcp-policy-migrate — a v0.50 profile migrates to tool policies (spec
 * docs/specs/2026-10-30-conduit-mcp-tool-policy.md §3.1; plan T3.4). The profile starts with
 * v0.50's `mcpTools` switches and no `mcpToolPolicy`:
 *   - open_session `true` → On · Always: it runs from an off-screen caller without a card;
 *   - open_file `false` (a control tool) → its new default, On · While on screen: refused off
 *     screen, runs without a card on screen;
 *   - send_message `false` (a messaging tool, v0.50 default on) → Off: refused;
 *   - the next settings write drops `mcpTools` and stores the migrated policy.
 * Its sessions.json holds v0.50 per-session `mcpToolOverrides` (true → On · Always, false → Off),
 * one session also holding a `mcpToolPolicy` the old keys overlay: the sessions restore with the
 * migrated layer, and the next sessions write drops `mcpToolOverrides`.
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
const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-policy-migrate-${label}-`));

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

const sessionsFile = join(userDataDir, 'sessions.json');
const seededHome = temp('seeded');
const seeded = (id, extra) => ({
  id,
  name: id,
  agentId: FAKE_AGENT_ID,
  home: seededHome,
  roots: [],
  status: 'exited',
  createdAt: 1,
  lastActiveAt: 1,
  ...extra,
});
writeFileSync(
  sessionsFile,
  JSON.stringify({
    version: 1,
    sessions: [
      seeded('v050-old', {
        mcpToolOverrides: { open_session: true, open_file: false, send_message: false },
      }),
      seeded('v050-both', {
        mcpToolPolicy: {
          open_session: { access: 'off', move: 'no' },
          open_terminal: { access: 'ask' },
        },
        mcpToolOverrides: { open_session: true },
      }),
    ],
  }),
);
/** The session layers the seeded sessions migrate to (old keys overlay the new ones). */
const MIGRATED_LAYERS = {
  'v050-old': {
    open_session: { access: 'on', when: 'always' },
    open_file: { access: 'off' },
    send_message: { access: 'off' },
  },
  'v050-both': {
    open_session: { access: 'on', when: 'always', move: 'no' },
    open_terminal: { access: 'ask' },
  },
};

await runScenario(
  'conduit-mcp-policy-migrate',
  async ({ page, log }) => {
    await tapMcp(page);
    const dirA = temp('a');
    const dirB = temp('b');
    const target = temp('target');
    writeFileSync(join(dirA, 'fixture.txt'), 'migrate fixture\n');

    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(
        await until(async () => (await activeSessionId(page)) === sessionId, 5_000),
        `${sessionId} never became active`,
      );
    };

    phase('v0.50 session overrides restore migrated');
    const layerOf = async (id) => (await sessions(page)).find((s) => s.id === id)?.mcpToolPolicy;
    for (const [id, want] of Object.entries(MIGRATED_LAYERS)) {
      assert(
        await until(async () => isDeepStrictEqual(await layerOf(id), want), 10_000),
        `${id} restored with ${JSON.stringify(await layerOf(id))}`,
      );
    }
    log('mcpToolOverrides → session layer, old over new ✓');

    phase('setup');
    const a = await openFake(page, dirA);
    const b = await openFake(page, dirB);
    await makeActive(b.sessionId);

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
    await makeActive(a.sessionId);
    const shown = await callTool(page, a.sessionId, 'open_file', { path: 'fixture.txt' });
    assert(errCode(shown) === undefined, `open_file on screen: ${JSON.stringify(shown)}`);
    assert((await page.locator('.askcard').count()) === 0, 'open_file asked on screen');
    log('open_file false → On · While on screen ✓');

    phase('messaging false → Off');
    const sent = await callTool(page, a.sessionId, 'send_message', { to: [b.handle], body: 'x' });
    assert(errCode(sent) === 'tool_disabled', `send_message: ${JSON.stringify(sent)}`);
    log('send_message false → Off ✓');

    phase('old keys gone on write');
    await setMessaging(page, true);
    const stored = () => JSON.parse(readFileSync(settingsFile, 'utf8')).settings;
    const migrated = (s) =>
      !('mcpTools' in s) &&
      isDeepStrictEqual(s.mcpToolPolicy?.open_session, {
        access: 'on',
        when: 'always',
        move: 'yes',
      }) &&
      isDeepStrictEqual(s.mcpToolPolicy?.open_file, { access: 'on', when: 'viewing' }) &&
      isDeepStrictEqual(s.mcpToolPolicy?.send_message, { access: 'off' });
    assert(
      await until(() => migrated(stored()), 10_000),
      `settings.json after a write: ${JSON.stringify(stored())}`,
    );
    log('settings.json holds mcpToolPolicy, no mcpTools ✓');
    // Opening A and B wrote sessions.json since the restore.
    const savedSeeded = () =>
      (JSON.parse(readFileSync(sessionsFile, 'utf8')).sessions ?? []).filter(
        (s) => s.id in MIGRATED_LAYERS,
      );
    const rewritten = (list) =>
      list.length === 2 &&
      list.every(
        (s) =>
          !('mcpToolOverrides' in s) && isDeepStrictEqual(s.mcpToolPolicy, MIGRATED_LAYERS[s.id]),
      );
    assert(
      await until(() => rewritten(savedSeeded()), 10_000),
      `sessions.json after a write: ${JSON.stringify(savedSeeded())}`,
    );
    log('sessions.json holds mcpToolPolicy, no mcpToolOverrides ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirA, dirB, target, seededHome]) await removeDir(d, { budgetMs: 10_000 });
  },
  { userDataDir },
);

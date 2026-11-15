/**
 * policy-profiles — profiles replace per-tool overrides (plan
 * docs/plans/2026-11-14-policy-permissions-machinery.plan.md, Task 2.4 e2e):
 *   - a v0.64 all-on session override is read as Lead +1 (DN-1), and its session's tool calls
 *     resolve as before;
 *   - the Lead profile given to a session lets it open a session off screen with focus:false
 *     without an ask; the call's Activity row carries the profile's reason, and the session it
 *     opens has no label.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionId,
  callTool,
  FAKE_AGENT_ID,
  fakeAgentProfile,
  handleOf,
  mcpState,
  openFake,
  records,
  sessions,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;
const temp = (label) => mkdtempSync(join(tmpdir(), `policy-profiles-${label}-`));

const ALL_TOOLS = [
  'list_sessions',
  'wait_sessions',
  'send_message',
  'read_inbox',
  'read_attachment',
  'request_input',
  'wait_request',
  'withdraw_request',
  'list_requests',
  'list_agents',
  'open_session',
  'open_terminal',
  'read_screen',
  'send_input',
  'close_session',
  'focus_session',
  'attach_folder',
  'open_file',
  'close_files',
  'open_review',
  'open_diff',
  'open_git_history',
  'open_url',
];

const userDataDir = fakeAgentProfile('policy-profiles');
const settingsFile = join(userDataDir, 'settings.json');
writeFileSync(
  settingsFile,
  JSON.stringify({
    version: 1,
    settings: { conduitMcp: true, restoreSessions: true, autoRelaunchStale: true },
  }),
);

const seededHome = temp('seeded');
const SEEDED_ID = 'v064-all-on';
writeFileSync(
  join(userDataDir, 'sessions.json'),
  JSON.stringify({
    version: 1,
    sessions: [
      {
        id: SEEDED_ID,
        name: SEEDED_ID,
        agentId: FAKE_AGENT_ID,
        home: seededHome,
        roots: [],
        // Stale, not exited: autoRelaunchStale starts it when its pane mounts, so it can be called.
        status: 'stale',
        createdAt: 1,
        lastActiveAt: 1,
        mcpToolPolicy: Object.fromEntries(ALL_TOOLS.map((t) => [t, { access: 'on' }])),
      },
    ],
  }),
);

const ACTIVITY_DIR = join(userDataDir, 'conduit-mcp', 'activity');
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const LEAD_REASON = 'allowed by Lead (session)';

/** Every Activity row written so far, from the day files under userData. */
function activityRows() {
  if (!existsSync(ACTIVITY_DIR)) return [];
  return readdirSync(ACTIVITY_DIR)
    .filter((name) => DAY_FILE.test(name))
    .flatMap((name) => {
      const lines = readFileSync(join(ACTIVITY_DIR, name), 'utf8').split('\n');
      // The last piece is '' or a row the host is still appending: only '\n'-terminated rows count.
      lines.pop();
      return lines.map((l) => JSON.parse(l));
    });
}

const policyOf = async (page, id) => (await mcpState(page))?.policy?.sessions?.[id] ?? null;

async function setAssignment(page, sessionId, profileId) {
  await tapMcp(page);
  const reply = await page.evaluate(
    ({ s, p }) =>
      new Promise((resolve) => {
        window.__assignReq = (window.__assignReq ?? 800_000) + 1;
        const requestId = window.__assignReq;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'mcp:policyResult' || m.requestId !== requestId) return;
          off();
          resolve(m);
        });
        window.agentDeck.post({
          type: 'mcp:setAssignment',
          requestId,
          point: { kind: 'session', sessionId: s },
          profileId: p,
        });
      }),
    { s: sessionId, p: profileId },
  );
  assert(
    reply.ok === true,
    `mcp:setAssignment ${profileId} on ${sessionId}: ${JSON.stringify(reply)}`,
  );
}

await runScenario(
  'policy-profiles',
  async ({ page, log }) => {
    await tapMcp(page);
    const dirC = temp('caller');
    const dirE = temp('active');
    const target = temp('target');

    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(
        await until(async () => (await activeSessionId(page)) === sessionId, 5_000),
        `${sessionId} never became active`,
      );
    };

    phase('v0.64 all-on override reads as Lead +1');
    assert(
      await until(async () => (await policyOf(page, SEEDED_ID))?.label === 'Lead +1', 10_000),
      `${SEEDED_ID} label: ${JSON.stringify(await policyOf(page, SEEDED_ID))}`,
    );
    log('mcpToolPolicy all-on → label "Lead +1" ✓');

    await makeActive(SEEDED_ID);
    assert(
      await until(
        () => records(SEEDED_ID, 'READY').some((r) => r.tools.includes('list_sessions')),
        30_000,
      ),
      `${SEEDED_ID} never came up with tools`,
    );
    log(`${await handleOf(page, SEEDED_ID)} relaunched with tools`);
    const listed = await callTool(page, SEEDED_ID, 'list_sessions', {});
    assert(
      errCode(listed) === undefined,
      `Worker-allowed list_sessions: ${JSON.stringify(listed)}`,
    );
    log('a Worker-allowed call resolves as before ✓');

    phase('Lead profile on a session opens off screen without an ask');
    const caller = await openFake(page, dirC);
    const active = await openFake(page, dirE);
    await makeActive(active.sessionId);
    await setAssignment(page, caller.sessionId, 'lead');
    assert(
      await until(
        async () => (await policyOf(page, caller.sessionId))?.label?.startsWith('Lead'),
        10_000,
      ),
      `caller label after Lead: ${JSON.stringify(await policyOf(page, caller.sessionId))}`,
    );

    const opened = await callTool(page, caller.sessionId, 'open_session', {
      path: target,
      agent: FAKE_AGENT_ID,
      focus: false,
    });
    assert(opened?.session_id, `open_session: ${JSON.stringify(opened)}`);
    assert((await page.locator('.askcard').count()) === 0, 'Lead asked for open_session');
    assert(
      (await activeSessionId(page)) === active.sessionId,
      'the Lead open moved the view off the active session',
    );

    const leadRow = () =>
      activityRows().find(
        (r) =>
          r.action === 'open_session' &&
          r.principal?.sessionId === caller.sessionId &&
          r.decidedBy === LEAD_REASON,
      );
    assert(
      await until(() => leadRow() !== undefined, 10_000),
      `no Activity row "${LEAD_REASON}" for ${caller.sessionId}: ${JSON.stringify(
        activityRows().filter((r) => r.action === 'open_session'),
      )}`,
    );
    log(`Activity row "${LEAD_REASON}" ✓`);

    assert(
      await until(
        async () => (await sessions(page)).some((s) => s.id === opened.session_id),
        10_000,
      ),
      'the opened session never reached the renderer',
    );
    assert(
      await until(async () => (await policyOf(page, opened.session_id)) !== null, 10_000),
      'the opened session has no policy row',
    );
    assert(
      (await policyOf(page, opened.session_id)).label === null,
      `opened session label: ${JSON.stringify(await policyOf(page, opened.session_id))}`,
    );
    log('the session Lead opened has label null ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirC, dirE, target, seededHome]) await removeDir(d, { budgetMs: 10_000 });
  },
  { userDataDir },
);

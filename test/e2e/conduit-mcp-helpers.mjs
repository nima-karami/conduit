/**
 * Shared driver for the conduit-mcp scenarios (docs/plans/2026-10-25-conduit-mcp-server.plan.md
 * T9.4). Sessions run `fixtures/fake-mcp-agent.mjs`, registered as the agent `e2e-fake-mcp` — the
 * host's e2e-only `fake` adapter matches that id — so the real shim, endpoint, token and notice
 * gate are all in the path. The fake's records are read from the JSONL file it appends per
 * session, never from the terminal stream: ConPTY doubles the cell at every wrap, which corrupted
 * any record wider than the terminal (see the fixture's header).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession, profileDir, REPO, tapBridge, typeLine } from './harness.mjs';

export const FAKE_AGENT_ID = 'e2e-fake-mcp';
export const FAKE_AGENT = join(REPO, 'test', 'e2e', 'fixtures', 'fake-mcp-agent.mjs');
export const NOTICE = '[conduit] New messages for you. Use the conduit read_inbox tool.';
export const URGENT_NOTICE =
  '[conduit] New messages for you (urgent). Use the conduit read_inbox tool.';

/** One scenario per process, so one profile and one records dir. */
let recordsDir = null;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(pred, ms, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

/**
 * A fresh profile with the fake agent registered, for `runScenario(name, fn, { userDataDir })`.
 * @param {string} label
 * @returns {string} the userDataDir
 */
export function fakeAgentProfile(label) {
  const userDataDir = profileDir(label);
  recordsDir = join(userDataDir, 'e2e-records');
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify([
      {
        id: FAKE_AGENT_ID,
        label: 'Fake MCP',
        command: process.execPath,
        args: [FAKE_AGENT, '--records', recordsDir],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
  return userDataDir;
}

/** Mirror the latest `mcp:state` broadcast into `window.__mcp`. Idempotent. */
export async function tapMcp(page) {
  await tapBridge(page);
  await page.evaluate(() => {
    if (window.__mcpTapped) return;
    window.__mcpTapped = true;
    window.__mcp = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'mcp:state') window.__mcp = m.state;
    });
    window.agentDeck.post({ type: 'ready' });
  });
}

export const mcpState = (page) => page.evaluate(() => window.__mcp);

/** The fake's records of `kind` for a session, in the order it wrote them. */
export function records(sessionId, kind) {
  if (!recordsDir) throw new Error('records: no fakeAgentProfile in this scenario');
  const file = join(recordsDir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  // The last piece is '' or a line the fake is still appending: only '\n'-terminated ones count.
  lines.pop();
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

/** Open a fake-agent session in `path` and wait for its MCP handshake to finish. */
export async function openFake(page, path, { projectId } = {}) {
  const sessionId = await openSession(page, {
    path,
    agentId: FAKE_AGENT_ID,
    ...(projectId !== undefined ? { projectId } : {}),
  });
  const ok = await until(
    () => records(sessionId, 'READY').some((r) => r.tools.includes('list_sessions')),
    30_000,
  );
  if (!ok) throw new Error(`fake agent in ${sessionId} never reported READY with tools`);
  const handle = await handleOf(page, sessionId);
  return { sessionId, handle };
}

/** The session's MCP handle, from the host's `mcp:state`. */
export async function handleOf(page, sessionId) {
  let handle = null;
  await until(async () => {
    const st = await mcpState(page);
    handle = st?.sessions?.[sessionId]?.handle ?? null;
    return handle !== null;
  }, 15_000);
  if (!handle) throw new Error(`no MCP handle for ${sessionId}`);
  return handle;
}

/** Type `call <tool> <json>` into a fake session and resolve its RESULT payload. */
export async function callTool(page, sessionId, tool, args = {}) {
  const before = records(sessionId, 'RESULT').length;
  await typeLine(page, sessionId, `call ${tool} ${JSON.stringify(args)}`);
  let result;
  const ok = await until(() => {
    const recs = records(sessionId, 'RESULT');
    if (recs.length <= before) return false;
    result = recs[recs.length - 1].result;
    return true;
  }, 20_000);
  if (!ok) throw new Error(`no RESULT for ${tool} in ${sessionId}`);
  return result;
}

/** Submitted lines that are notices (they start with `[conduit]`). */
export function notices(sessionId) {
  return records(sessionId, 'INPUT').filter((r) => r.line.startsWith('[conduit]'));
}

/** Post renderer input (keys) into a session, as the terminal pane does. */
export function keys(page, sessionId, data) {
  return page.evaluate(
    ({ s, d }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: d }),
    { s: sessionId, d: data },
  );
}

/** Pause or resume notices for a session through the host's `mcp:pause`. */
export function pauseNotices(page, sessionId, paused) {
  return page.evaluate(
    ({ s, p }) => window.agentDeck.post({ type: 'mcp:pause', sessionId: s, paused: p }),
    { s: sessionId, p: paused },
  );
}

/** Flip `conduitMcp` over `updateSettings` and wait for the host to broadcast it back. */
export function setMessaging(page, on) {
  return page.evaluate(
    (want) =>
      new Promise((resolve) => {
        let sent = false;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          if (!sent) {
            sent = true;
            window.agentDeck.post({
              type: 'updateSettings',
              settings: { ...m.settings, conduitMcp: want },
            });
          }
          if (m.settings?.conduitMcp === want) {
            off();
            resolve();
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
    on,
  );
}

/** The session's current tool list: its last re-list after a list_changed, else its first. */
export function toolsSeen(sessionId) {
  const relisted = records(sessionId, 'TOOLS');
  if (relisted.length > 0) return relisted[relisted.length - 1].tools;
  return records(sessionId, 'READY')[0]?.tools ?? [];
}

const SEG = { On: 'on', Off: 'off', Inherit: 'inherit' };

/**
 * Set one tool's override through the session's MCP tools dialog (card menu → MCP tools…), and
 * wait for the host to persist it: the dialog only reverts on a refusal, so the click alone
 * proves nothing.
 * @param {'On' | 'Off' | 'Inherit'} value
 */
export async function enableToolViaDialog(page, sessionId, tool, value) {
  await tapBridge(page);
  await page.locator(`.session[data-sessionid="${sessionId}"]`).click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: 'MCP tools…' }).click();
  const dialog = page.locator('.mcptools[role="dialog"]');
  await dialog.waitFor({ timeout: 5_000 });
  await dialog
    .locator(`[role="radiogroup"][aria-label="${tool}"] [data-seg="${SEG[value]}"]`)
    .click();
  const want = value === 'Inherit' ? null : value === 'On';
  await page.waitForFunction(
    ({ id, t, w }) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (s?.mcpToolOverrides?.[t] ?? null) === w;
    },
    { id: sessionId, t: tool, w: want },
    { timeout: 10_000 },
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5_000 });
}

/** The sessions of the latest host `state` (needs `tapBridge`). */
export const sessions = (page) => page.evaluate(() => window.__sessions || []);

/** The id of the sidebar's selected session row (`sessionRowClass({selected: true})`). */
export const activeSessionId = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.session.session--active')?.getAttribute('data-sessionid') ?? null,
  );

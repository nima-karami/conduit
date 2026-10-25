/**
 * Shared driver for the conduit-mcp scenarios (docs/plans/2026-10-25-conduit-mcp-server.plan.md
 * T9.4). Sessions run `fixtures/fake-mcp-agent.mjs`, registered as the agent `e2e-fake-mcp` — the
 * host's e2e-only `fake` adapter matches that id — so the real shim, endpoint, token and notice
 * gate are all in the path. The fake's records are read from `window.__capBy`, line breaks and
 * escape sequences stripped, deduped by their `seq`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureFailure,
  finishScenario,
  launchApp,
  makeLog,
  openSession,
  profileDir,
  REPO,
  tapBridge,
  typeLine,
} from './harness.mjs';

export const FAKE_AGENT_ID = 'e2e-fake-mcp';
export const FAKE_AGENT = join(REPO, 'test', 'e2e', 'fixtures', 'fake-mcp-agent.mjs');
export const NOTICE = '[conduit] New messages for you. Use the conduit read_inbox tool.';
export const URGENT_NOTICE =
  '[conduit] New messages for you (urgent). Use the conduit read_inbox tool.';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const CSI = new RegExp(`${ESC}\\[[0-9;?<>]*[ -/]*[@-~]`, 'g');
const plain = (s) =>
  s
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(/[\r\n]/g, '');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(pred, ms, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

/** Mirror the latest `mcp:state` broadcast into `window.__mcp`. Idempotent. */
export async function tapMcp(page) {
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

/** Launch Conduit with the fake agent registered in a fresh profile. */
export async function launchWithFakeAgents(label) {
  const userDataDir = profileDir(label);
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify([
      {
        id: FAKE_AGENT_ID,
        label: 'Fake MCP',
        command: process.execPath,
        args: [FAKE_AGENT],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
  const launched = await launchApp({ userDataDir });
  await tapBridge(launched.page);
  await tapMcp(launched.page);
  return { ...launched, userDataDir };
}

/**
 * The runScenario shape (cleanup before the one exit), over a profile with the fake agent.
 * @param {string} name
 * @param {(ctx: { app: any, page: any, userDataDir: string, log: (...a: any[]) => void }) => Promise<void>} fn
 */
export async function runMcpScenario(name, fn) {
  if (process.platform !== 'win32') {
    console.log(`[${name}] SKIP — suite is Windows-only (non-win32 platform)`);
    await finishScenario(0);
  }
  const log = makeLog(name);
  let launched = null;
  let code = 0;
  try {
    launched = await launchWithFakeAgents(name);
    await fn({ ...launched, log });
    log('PASS ✓');
  } catch (e) {
    if (e?.name === 'AssertionError') {
      log('FAIL ✗', e.message);
      code = 1;
    } else {
      console.error(`[${name}] ERROR:`, e?.message || e);
      if (e?.stack) console.error(e.stack);
      code = 2;
    }
  }
  if (code !== 0) await captureFailure();
  try {
    await launched?.cleanup();
  } catch {
    /* already gone */
  }
  await finishScenario(code);
}

/** The fake's records of `kind` for a session, in order, one per `seq`. */
export async function records(page, sessionId, kind) {
  const raw = await page.evaluate((id) => window.__capBy?.[id] ?? '', sessionId);
  const out = new Map();
  const re = new RegExp(`FAKE-MCP ${kind} (\\{.*?\\}) <<END>>`, 'g');
  for (const m of plain(raw).matchAll(re)) {
    try {
      const rec = JSON.parse(m[1]);
      if (!out.has(rec.seq)) out.set(rec.seq, rec);
    } catch {
      // A record cut by a repaint mid-way; its intact copy is matched separately.
    }
  }
  return [...out.values()];
}

/** Open a fake-agent session in `path` and wait for its MCP handshake to finish. */
export async function openFake(page, path) {
  const sessionId = await openSession(page, { path, agentId: FAKE_AGENT_ID });
  const ok = await until(async () => {
    const raw = await page.evaluate((id) => window.__capBy?.[id] ?? '', sessionId);
    return plain(raw).includes('FAKE-MCP READY tools=list_sessions');
  }, 30_000);
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
  const before = (await records(page, sessionId, 'RESULT')).length;
  await typeLine(page, sessionId, `call ${tool} ${JSON.stringify(args)}`);
  let result;
  const ok = await until(async () => {
    const recs = await records(page, sessionId, 'RESULT');
    if (recs.length <= before) return false;
    result = recs[recs.length - 1].result;
    return true;
  }, 20_000);
  if (!ok) throw new Error(`no RESULT for ${tool} in ${sessionId}`);
  return result;
}

/** Submitted lines that are notices (they start with `[conduit]`). */
export async function notices(page, sessionId) {
  return (await records(page, sessionId, 'INPUT')).filter((r) => r.line.startsWith('[conduit]'));
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

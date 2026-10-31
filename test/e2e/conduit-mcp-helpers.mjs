/**
 * Shared driver for the conduit-mcp scenarios (docs/plans/2026-10-25-conduit-mcp-server.plan.md
 * T9.4). Sessions run `fixtures/fake-mcp-agent.mjs`, registered as the agent `e2e-fake-mcp` — the
 * host's e2e-only `fake` adapter matches that id — so the real shim, endpoint, token and notice
 * gate are all in the path. The fake's records are read from the JSONL file it appends per
 * session, never from the terminal stream: ConPTY doubles the cell at every wrap, which corrupted
 * any record wider than the terminal (see the fixture's header).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { openSession, profileDir, REPO, tapBridge, typeLine } from './harness.mjs';

/** The installed-CLI fake (plan 2026-10-27-conduit-mcp-install T5.1); reads Install's entry. */
export const FAKE_CLI = join(REPO, 'test', 'e2e', 'fixtures', 'fake-agent-cli.mjs');

/**
 * A home inside the profile for every config Install reads or writes: HOME/USERPROFILE point at
 * it and the CLIs' own dir overrides are emptied, so nothing reaches the real ~/.claude.json even
 * when this machine sets CLAUDE_CONFIG_DIR, CODEX_HOME or XDG_CONFIG_HOME.
 * @param {string} userDataDir
 */
export function isolatedHome(userDataDir) {
  const homeDir = join(userDataDir, 'home');
  // A real profile has these: Windows PowerShell's GetFolderPath returns '' for a missing
  // AppData\Local, so the launch's default PowerShell session wrote its module cache to
  // `Microsoft\Windows\PowerShell` under its cwd, the repo.
  mkdirSync(join(homeDir, 'AppData', 'Local'), { recursive: true });
  mkdirSync(join(homeDir, 'AppData', 'Roaming'), { recursive: true });
  return {
    homeDir,
    env: {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CONFIG_DIR: '',
      CODEX_HOME: '',
      XDG_CONFIG_HOME: '',
    },
  };
}

/**
 * `{ [pathKey]: dir + PATH }` under the key this process actually has: on Windows it is `Path`,
 * and a second `PATH` key beside it leaves the child's lookup to chance.
 * @param {string} dir
 */
export function pathWith(dir) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { [key]: `${dir}${delimiter}${process.env[key] ?? ''}` };
}

/**
 * A `claude.cmd` in `binDir` that runs FAKE_CLI as Claude (`--as claude`), so typing `claude` in a
 * Conduit shell is detected as Claude and the fake connects as `claude-code`.
 */
export function fakeClaudeOnPath(binDir, recordsDir, label) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'claude.cmd'),
    `@"${process.execPath}" "${FAKE_CLI}" --as claude --records "${recordsDir}" --name ${label}\r\n`,
  );
}

/** FAKE_CLI's records of `kind` under `label`. */
export function cliRecords(dir, label, kind) {
  const file = join(dir, `${label}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

/** Settings from the footer, then its MCP tab. */
export async function openMcpSettings(page) {
  await page.locator('.footbtn[title^="Settings"]').click();
  await page.locator('.settings__navitem', { hasText: 'MCP' }).click();
  await page.locator('.mcp-install-row').first().waitFor({ timeout: 10_000 });
}

/** The MCP tab's row for one CLI, by its display name. */
export const installRow = (page, name) =>
  page.locator('.mcp-install-row').filter({
    has: page.locator('.mcp-install-row__name', { hasText: name }),
  });

/** Case- and separator-insensitive on Windows, as the host compares folders. */
export const normalizePath = (value) => {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** The command and shim this build writes into a CLI's entry (spec §3.4). */
export function conduitCommand(app) {
  return app.evaluate(({ app: electronApp }) => {
    const separator = process.platform === 'win32' ? '\\' : '/';
    const shim = electronApp.isPackaged
      ? [process.resourcesPath, 'conduit-mcp', 'conduit-mcp-shim.cjs'].join(separator)
      : [electronApp.getAppPath(), 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs'].join(
          separator,
        );
    return { command: process.execPath, shim };
  });
}

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

const SEG = { On: 'on', Off: 'off', Ask: 'ask', Inherit: 'inherit' };

/**
 * Set one tool's session-layer access through the session's MCP tools dialog (card menu → MCP
 * tools…), and wait for the host to persist it: the dialog only reverts on a refusal, so the
 * click alone proves nothing.
 * @param {'On' | 'Off' | 'Ask' | 'Inherit'} value
 */
export async function enableToolViaDialog(page, sessionId, tool, value) {
  await tapBridge(page);
  await page.locator(`.session[data-sessionid="${sessionId}"]`).click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: 'MCP tools…' }).click();
  const dialog = page.locator('.mcptools[role="dialog"]');
  await dialog.waitFor({ timeout: 5_000 });
  await dialog
    .locator(`[role="radiogroup"][aria-label="${tool} access"] [data-seg="${SEG[value]}"]`)
    .click();
  const want = value === 'Inherit' ? null : SEG[value];
  await page.waitForFunction(
    ({ id, t, w }) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (s?.mcpToolPolicy?.[t]?.access ?? null) === w;
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

/**
 * Patch one tool's session layer through the host's `mcp:setToolPolicy`, as the dialog does, and
 * wait for the session to reflect it (`'inherit'` = the field is gone).
 * @param {Record<string, string>} patch e.g. `{ when: 'always' }`
 */
export async function setSessionPolicy(page, sessionId, tool, patch) {
  await tapBridge(page);
  const ok = await page.evaluate(
    ({ s, t, p }) =>
      new Promise((resolve) => {
        window.__policyReq = (window.__policyReq ?? 900_000) + 1;
        const requestId = window.__policyReq;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'mcp:toolPolicyResult' || m.requestId !== requestId) return;
          off();
          resolve(m.ok);
        });
        window.agentDeck.post({
          type: 'mcp:setToolPolicy',
          requestId,
          sessionId: s,
          tool: t,
          patch: p,
        });
      }),
    { s: sessionId, t: tool, p: patch },
  );
  if (!ok) throw new Error(`mcp:setToolPolicy refused ${tool} ${JSON.stringify(patch)}`);
  await page.waitForFunction(
    ({ id, t, p }) => {
      const layer = (window.__sessions || []).find((x) => x.id === id)?.mcpToolPolicy?.[t] ?? {};
      return Object.entries(p).every(([f, v]) =>
        v === 'inherit' ? !(f in layer) : layer[f] === v,
      );
    },
    { id: sessionId, t: tool, p: patch },
    { timeout: 10_000 },
  );
}

/**
 * `updateSettings` with `mcpToolPolicy[tool]` = `policy` merged over its current value; waits for
 * the host to broadcast it back.
 * @param {Record<string, string>} policy e.g. `{ access: 'ask' }`
 */
export function setGlobalPolicy(page, tool, policy) {
  return page.evaluate(
    ({ t, p }) =>
      new Promise((resolve) => {
        let sent = false;
        const matches = (s) =>
          Object.entries(p).every(([f, v]) => s?.mcpToolPolicy?.[t]?.[f] === v);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          if (!sent) {
            sent = true;
            const cur = m.settings.mcpToolPolicy;
            window.agentDeck.post({
              type: 'updateSettings',
              settings: { ...m.settings, mcpToolPolicy: { ...cur, [t]: { ...cur[t], ...p } } },
            });
          }
          if (matches(m.settings)) {
            off();
            resolve();
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
    { t: tool, p: policy },
  );
}

/**
 * Type `call <tool> <json>` without waiting for its result: resolves, once the fake has sent it
 * (its CALL record), the RESULT count before it, for `resultAfter`.
 */
export async function startCall(page, sessionId, tool, args = {}) {
  const before = records(sessionId, 'RESULT').length;
  const calls = records(sessionId, 'CALL').length;
  await typeLine(page, sessionId, `call ${tool} ${JSON.stringify(args)}`);
  const sent = await until(() => records(sessionId, 'CALL').length > calls, 20_000);
  if (!sent) throw new Error(`the fake in ${sessionId} never sent ${tool}`);
  return before;
}

/** The first RESULT payload after the first `before` ones, or null after `ms`. */
export async function resultAfter(sessionId, before, ms) {
  let result = null;
  await until(() => {
    const recs = records(sessionId, 'RESULT');
    if (recs.length <= before) return false;
    result = recs[before].result;
    return true;
  }, ms);
  return result;
}

/** Answer the shown approval card. @param {'approve' | 'deny' | 'always'} answer */
export function clickAskAnswer(page, answer) {
  return page.locator(`.askcard button[data-answer="${answer}"]`).click();
}

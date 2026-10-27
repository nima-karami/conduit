/**
 * conduit-mcp-control-terminal — open_terminal runs an arbitrary command as argv, and the command
 * is persisted so Relaunch and Duplicate run it again (spec
 * docs/specs/2026-10-27-conduit-mcp-control-tools.md §7; plan T6.3). The command is this test's
 * own Node, printing a marker tagged with its pid, so each run of it is told apart from the
 * scrollback a relaunch may replay.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  enableToolViaDialog,
  fakeAgentProfile,
  openFake,
  sessions,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario, typeLine } from './harness.mjs';

const errCode = (r) => r?.error?.code;
const SCRIPT =
  "process.stdout.write('CTRL-MARK '+process.pid+'\\n');" +
  "process.stdin.on('data',d=>{if(String(d).includes('q'))process.stdin.destroy()})";

/** The pids of every complete marker line so far; a chunk split mid-pid must not yield a prefix. */
const markerPids = (page, sid) =>
  page.evaluate(
    (id) => [
      ...new Set(
        [...(window.__capBy?.[id] ?? '').matchAll(/CTRL-MARK (\d+)\r?\n/g)].map((m) => m[1]),
      ),
    ],
    sid,
  );

const statusOf = async (page, sid) => (await sessions(page)).find((s) => s.id === sid)?.status;

await runScenario(
  'conduit-mcp-control-terminal',
  async ({ page, log }) => {
    await tapMcp(page);
    const dirA = mkdtempSync(join(tmpdir(), 'conduit-mcp-control-term-'));

    phase('setup');
    const main = await openFake(page, dirA);
    await enableToolViaDialog(page, main.sessionId, 'open_terminal', 'On');

    phase('marker');
    const r = await callTool(page, main.sessionId, 'open_terminal', {
      path: dirA,
      command: process.execPath,
      args: ['-e', SCRIPT],
    });
    assert(r.session_id, `open_terminal: ${JSON.stringify(r)}`);
    assert(r.handle === null, `node has no MCP adapter, got handle ${r.handle}`);
    assert(r.agent === 'node' && r.label === 'node', `label/agent: ${JSON.stringify(r)}`);
    const sid = r.session_id;
    assert(
      await until(async () => (await markerPids(page, sid)).length === 1, 30_000),
      `no marker from ${sid}`,
    );
    const [firstPid] = await markerPids(page, sid);
    log('marker ✓');

    phase('relaunch');
    await typeLine(page, sid, 'q');
    assert(
      await until(async () => (await statusOf(page, sid)) === 'exited', 15_000),
      `status after q: ${await statusOf(page, sid)}`,
    );
    await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);
    assert(
      await until(async () => (await markerPids(page, sid)).some((p) => p !== firstPid), 30_000),
      `relaunch printed no new marker: ${JSON.stringify(await markerPids(page, sid))}`,
    );
    log('relaunch ran the command again ✓');

    phase('duplicate');
    const before = (await sessions(page)).map((s) => s.id);
    await page.evaluate((id) => window.agentDeck.post({ type: 'duplicate', id }), sid);
    let dupId = null;
    assert(
      await until(async () => {
        dupId = (await sessions(page)).find((s) => !before.includes(s.id))?.id ?? null;
        return dupId !== null;
      }, 10_000),
      'duplicate created no session',
    );
    // A pane starts its PTY on its first laid-out frame; a hidden one never does.
    await page.locator(`.session[data-sessionid="${dupId}"]`).click();
    assert(
      await until(async () => (await markerPids(page, dupId)).length === 1, 30_000),
      `no marker from the duplicate ${dupId}`,
    );
    log('duplicate ran the command ✓');

    phase('missing command');
    const count = (await sessions(page)).length;
    const missing = await callTool(page, main.sessionId, 'open_terminal', {
      path: dirA,
      command: 'no-such-cmd-xyz',
    });
    assert(errCode(missing) === 'command_not_found', `missing: ${JSON.stringify(missing)}`);
    await sleep(1_000);
    assert((await sessions(page)).length === count, 'a missing command still created a session');
    log('command_not_found, nothing created ✓');

    phase('cleanup');
    // The sessions hold the folder as cwd; close them before removing it.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    await removeDir(dirA, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('control-term') },
);

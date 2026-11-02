/**
 * hc-core-restart — `hc server restart` of the profile's own core while a session is live
 * (program W8; architecture F10): programs keep running across a core restart, the server
 * reconciles and keeps the session live, and the app's observer re-attaches with history 0.
 *   - the restart runs in the scenario's own hc session with the app's core env and cwd;
 *   - afterwards the session is still `running` / live, on the same hc terminal and program;
 *   - typing reaches the program through the server and the pane shows its echo;
 *   - the history from before the restart is in the pane exactly once (no double replay).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  hcTerminalOf,
  logicalLines,
  openSession,
  ownHc,
  PROBE_AGENT_ID,
  phase,
  probeProfile,
  removeDir,
  runScenario,
  typeLine,
} from './harness.mjs';

const probe = probeProfile('hc-restart');
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';
const session = (page, id) =>
  page.evaluate((s) => (window.__sessions || []).find((x) => x.id === s) ?? null, id);
const count = (text, needle) => text.split(needle).length - 1;

await runScenario(
  'hc-core-restart',
  async ({ page, userDataDir, log }) => {
    const work = mkdtempSync(join(tmpdir(), 'conduit-hc-restart-'));
    await page.evaluate(() => {
      window.__terms = {};
    });

    phase('live session');
    const sid = await openSession(page, { path: work, agentId: PROBE_AGENT_ID });
    assert(
      await until(() => probe.records('READY').length === 1, 20_000),
      'the probe never started',
    );
    await typeLine(page, sid, 'before-core-81');
    assert(
      await until(
        async () => (await paneText(page, sid)).includes('PROBE-LINE before-core-81'),
        15_000,
      ),
      'the pane never showed the first line',
    );
    const terminal = hcTerminalOf(userDataDir, sid);
    assert(terminal?.address, `no live hc terminal for ${sid}`);
    const pid = probe.records('READY')[0].pid;

    phase('hc server restart');
    const status = ownHc(userDataDir, ['server', 'status', '--json']);
    log(`core before: ${status.out.trim().slice(0, 200)}`);
    const r = ownHc(userDataDir, ['server', 'restart'], { timeout: 60_000 });
    log(`hc server restart: exit ${r.status}: ${r.out.trim().slice(0, 300)}`);
    assert(r.status === 0, `hc server restart failed: exit ${r.status}: ${r.out.slice(0, 300)}`);
    const after = ownHc(userDataDir, ['server', 'status', '--json']);
    log(`core after: ${after.out.trim().slice(0, 200)}`);
    assert(
      hcTerminalOf(userDataDir, sid)?.address === terminal.address,
      'the program did not survive the core restart',
    );

    phase('reconciled and re-attached');
    // Both the server's and the app's hc connections reconnect on their own; give them a moment.
    await sleep(2_000);
    assert(
      await until(async () => {
        const s = await session(page, sid);
        return s?.status === 'running' && s.runtime?.spawn === 'live';
      }, 20_000),
      `the session is not live after the core restart: ${JSON.stringify(await session(page, sid))}`,
    );
    // Keep typing until the line is echoed: the first may land before the server's hc is back.
    let n = 0;
    const echoed = await until(
      async () => {
        n += 1;
        await typeLine(page, sid, `after-core-${n}`);
        return until(
          async () => (await paneText(page, sid)).includes(`PROBE-LINE after-core-${n}`),
          3_000,
        );
      },
      40_000,
      0,
    );
    assert(
      echoed,
      `no echo in the pane after the core restart: ${JSON.stringify((await paneText(page, sid)).slice(-400))}`,
    );
    log(`echo after the core restart on attempt ${n} ✓`);
    const line = probe.records('LINE').find((x) => x.line === `after-core-${n}`);
    assert(line?.pid === pid, `input reached pid ${line?.pid}, not ${pid}`);
    assert(probe.records('READY').length === 1, 'the program was launched again');
    const text = await paneText(page, sid);
    assert(
      count(text, 'PROBE-LINE before-core-81') === 1,
      `the pre-restart history is in the pane ${count(text, 'PROBE-LINE before-core-81')} times`,
    );

    phase('cleanup');
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
    await until(async () => (await session(page, sid)) === null, 15_000);
    await removeDir(work, { budgetMs: 10_000 });
  },
  { userDataDir: probe.userDataDir },
);

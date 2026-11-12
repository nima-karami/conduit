/**
 * server-restart-supervisor — the Conduit server restarts under a live session (program W8;
 * architecture F6/F9, D29). A test C2 client asks the profile's own server for `server.restart`;
 * the supervisor exits with it, and the app, finding the supervisor gone, starts a new one.
 *   - while C2 is down the app shows input as paused ("Reconnecting — input paused", D29);
 *   - keystrokes typed while it is down are dropped, never buffered and replayed later;
 *   - the app reconnects to the new server and typing reaches the program again;
 *   - the agent's terminal survives: same hc terminal, same program, no second launch.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C2 } from './c2-peer.mjs';
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
  REPO,
  removeDir,
  runScenario,
  typeLine,
} from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';

const probe = probeProfile('server-restart');
const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';
const session = (page, id) =>
  page.evaluate((s) => (window.__sessions || []).find((x) => x.id === s) ?? null, id);

/** One C2 request after hello on a fresh connection; resolves once the connection has closed. */
async function restartServer(endpoint) {
  const c2 = await C2.open(endpoint);
  const closed = new Promise((resolve) => c2.socket.once('close', resolve));
  await c2.call('hello', { appVersion: APP_VERSION, generation: SERVER_PROTOCOL_GENERATION });
  // The server may drop the connection before it answers, which C2 reports as a rejection.
  const outcome = c2.call('server.restart', { reason: 'user' }).then(
    (result) => ({ result }),
    (error) => ({ error: error.message }),
  );
  await closed;
  return outcome;
}

/** What the app shows of a paused input: anywhere in the window's text or in the session's pane. */
const pausedShown = (page, sid) =>
  page.evaluate((id) => {
    const pane = window.__terms?.[id];
    const b = pane?.buffer.active;
    let text = document.body.innerText;
    if (b) for (let i = 0; i < b.length; i++) text += `\n${b.getLine(i)?.translateToString(true)}`;
    return /input paused/i.test(text);
  }, sid);

await runScenario(
  'server-restart-supervisor',
  async ({ page, userDataDir, log }) => {
    const names = teardownNames(userDataDir, process.platform, tmpdir());
    const work = mkdtempSync(join(tmpdir(), 'conduit-server-restart-'));
    await page.evaluate(() => {
      window.__terms = {};
    });

    phase('live session');
    const sid = await openSession(page, { path: work, agentId: PROBE_AGENT_ID });
    assert(
      await until(() => probe.records('READY').length === 1, 20_000),
      'the probe never started',
    );
    await typeLine(page, sid, 'before-restart-91');
    assert(
      await until(() => probe.records('LINE').some((r) => r.line === 'before-restart-91'), 15_000),
      'the first line never reached the program',
    );
    const terminal = hcTerminalOf(userDataDir, sid);
    assert(terminal?.address, `no live hc terminal for ${sid}`);
    const pid = probe.records('READY')[0].pid;
    const supervisorBefore = ownHc(userDataDir, ['get', names.supervisorName, '--json']).json();
    log(`supervisor before: ${supervisorBefore.address} (${supervisorBefore.state ?? 'live'})`);

    phase('server.restart from a test client');
    let pausedSeen = false;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        if (await pausedShown(page, sid)) pausedSeen = true;
        await sleep(100);
      }
    })();
    const reply = await restartServer(names.serverEndpoint);
    log(`server.restart reply: ${JSON.stringify(reply)}`);
    // The server is gone: these keystrokes must be dropped, not delivered once it is back.
    for (let i = 0; i < 3; i++) {
      await typeLine(page, sid, `while-down-${i}`);
      await sleep(150);
    }

    phase('a new supervisor and server');
    assert(
      await until(
        () => {
          const r = ownHc(userDataDir, ['get', names.supervisorName, '--json']);
          if (r.status !== 0) return false;
          const t = r.json();
          return t.address !== supervisorBefore.address && (t.state ?? 'live') === 'live';
        },
        45_000,
        500,
      ),
      'no new supervisor was started after the old one exited (F9)',
    );
    // Keep typing until a line lands: the app reconnects with a backoff of its own.
    let n = 0;
    const resumed = await until(
      async () => {
        n += 1;
        await typeLine(page, sid, `after-restart-${n}`);
        return until(
          () => probe.records('LINE').some((r) => r.line === `after-restart-${n}`),
          2_000,
        );
      },
      45_000,
      0,
    );
    assert(resumed, 'typing never resumed after the server restart');
    log(`typing resumed on attempt ${n} ✓`);
    assert(
      await until(
        async () => (await paneText(page, sid)).includes(`PROBE-LINE after-restart-${n}`),
        15_000,
      ),
      'the pane never showed the echo after the restart',
    );
    watching = false;
    await watcher;

    phase('dropped while down; the agent survived');
    await sleep(2_000);
    const down = probe.records('LINE').filter((r) => r.line.startsWith('while-down-'));
    assert(
      down.length === 0,
      `keystrokes typed while down were delivered: ${JSON.stringify(down)}`,
    );
    const line = probe.records('LINE').find((r) => r.line === `after-restart-${n}`);
    assert(line.pid === pid, `input reached pid ${line.pid}, not ${pid}`);
    assert(probe.records('READY').length === 1, 'the program was launched again');
    assert(
      hcTerminalOf(userDataDir, sid)?.address === terminal.address,
      'the agent is not on the same hc terminal',
    );
    const s = await session(page, sid);
    assert(
      s?.status === 'running' && s.runtime?.spawn === 'live',
      `session after restart: ${JSON.stringify(s)}`,
    );
    log('agent survived; keystrokes while down dropped ✓');
    assert(pausedSeen, 'the app never showed input as paused while the server was down (D29)');

    phase('cleanup');
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
    await until(async () => (await session(page, sid)) === null, 15_000);
    await removeDir(work, { budgetMs: 10_000 });
  },
  { userDataDir: probe.userDataDir },
);

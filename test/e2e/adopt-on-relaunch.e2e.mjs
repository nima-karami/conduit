/**
 * adopt-on-relaunch — quitting the app leaves its agents running in hc (architecture F4), and the
 * next launch on the same profile adopts them (program W8):
 *   - a probe session is typed into, then the app quits; its hc terminal stays live;
 *   - relaunched on the same userData, the session is `running` with a live spawn, not stale;
 *   - its pane shows the history from before the quit;
 *   - typing reaches the SAME program (same hc terminal, same pid, no second launch).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  closeApp,
  hcTerminalOf,
  launchApp,
  logicalLines,
  openSession,
  PROBE_AGENT_ID,
  phase,
  probeProfile,
  removeDir,
  runScenario,
  shutdownApp,
  tapBridge,
  typeLine,
} from './harness.mjs';

const probe = probeProfile('adopt');
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';
const session = (page, id) =>
  page.evaluate((s) => (window.__sessions || []).find((x) => x.id === s) ?? null, id);

await runScenario(
  'adopt-on-relaunch',
  async ({ app, page, userDataDir, log }) => {
    const work = mkdtempSync(join(tmpdir(), 'conduit-adopt-'));
    await page.evaluate(() => {
      window.__terms = {};
    });

    phase('first launch: open and type');
    const sid = await openSession(page, { path: work, agentId: PROBE_AGENT_ID });
    assert(
      await until(() => probe.records('READY').length === 1, 20_000),
      'the probe never started',
    );
    await typeLine(page, sid, 'before-quit-71');
    assert(
      await until(() => probe.records('LINE').some((r) => r.line === 'before-quit-71'), 15_000),
      'the first line never reached the program',
    );
    assert(
      await until(
        async () => (await paneText(page, sid)).includes('PROBE-LINE before-quit-71'),
        10_000,
      ),
      'the pane never showed the first line',
    );
    const terminal = hcTerminalOf(userDataDir, sid);
    assert(terminal?.address, `no live hc terminal for ${sid}: ${JSON.stringify(terminal)}`);
    const pid = probe.records('READY')[0].pid;
    log(`hc terminal ${terminal.address}, probe pid ${pid}`);

    phase('quit');
    await closeApp(app, page);
    // Quit is the app's alone: the program keeps running in hc.
    await sleep(1_500);
    const afterQuit = hcTerminalOf(userDataDir, sid);
    assert(
      afterQuit?.address === terminal.address,
      `the hc terminal did not survive the quit: ${JSON.stringify(afterQuit)}`,
    );

    phase('relaunch on the same profile');
    let second = null;
    try {
      second = await launchApp({ userDataDir });
      const page2 = second.page;
      // Pane registration happens at mount, so __terms must exist before the bundle runs.
      await page2.addInitScript(() => {
        window.__terms = {};
      });
      await page2.reload();
      await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20_000 });
      await tapBridge(page2);
      assert(
        await until(async () => (await session(page2, sid)) !== null, 20_000),
        'the session is missing after the relaunch',
      );
      assert(
        await until(async () => {
          const s = await session(page2, sid);
          return s?.status === 'running' && s.runtime?.spawn === 'live';
        }, 20_000),
        `the session was not adopted live: ${JSON.stringify(await session(page2, sid))}`,
      );
      await page2.locator(`.session[data-sessionid="${sid}"]`).click();
      assert(
        await until(
          async () => (await paneText(page2, sid)).includes('PROBE-LINE before-quit-71'),
          20_000,
        ),
        `the relaunched pane lacks the history: ${JSON.stringify(await paneText(page2, sid))}`,
      );
      log('adopted live with history ✓');

      phase('typing after the relaunch');
      await typeLine(page2, sid, 'after-relaunch-72');
      assert(
        await until(
          () => probe.records('LINE').some((r) => r.line === 'after-relaunch-72'),
          15_000,
        ),
        `typing after the relaunch never reached the program: ${JSON.stringify(probe.records().slice(-4))}`,
      );
      assert(
        await until(
          async () => (await paneText(page2, sid)).includes('PROBE-LINE after-relaunch-72'),
          10_000,
        ),
        'the relaunched pane never showed the echo',
      );
      const line = probe.records('LINE').find((r) => r.line === 'after-relaunch-72');
      assert(line.pid === pid, `a different program got the input: pid ${line.pid} ≠ ${pid}`);
      assert(
        probe.records('READY').length === 1,
        `the program was launched again: ${probe.records('READY').length} READY records`,
      );
      const now = hcTerminalOf(userDataDir, sid);
      assert(
        now?.address === terminal.address,
        `not the same hc terminal: ${now?.address} ≠ ${terminal.address}`,
      );
      log('same hc terminal, same program ✓');

      phase('cleanup');
      await page2.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
      await until(async () => (await session(page2, sid)) === null, 15_000);
      await closeApp(second.app, page2);
      await removeDir(work, { budgetMs: 10_000 });
    } finally {
      if (second) await shutdownApp(second.app, second.page);
    }
  },
  { userDataDir: probe.userDataDir },
);

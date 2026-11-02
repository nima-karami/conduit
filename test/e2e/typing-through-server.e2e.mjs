/**
 * typing-through-server — the renderer's keystrokes, a bracketed paste and a resize all reach the
 * program through the Conduit server (program W8; architecture D19: the server is the terminal's
 * only active viewer, the app an hc observer). Asserted from the program's own view: the probe
 * (fixtures/echo-probe.cjs) records every stdin chunk and its terminal size.
 *   - real key presses into the focused xterm arrive as typed;
 *   - xterm's paste() under the program's ESC[?2004h arrives wrapped in ESC[200~ … ESC[201~;
 *   - a window resize refits the xterm and the program then reports exactly the xterm's size;
 *   - the pane shows the program's echo of each.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  logicalLines,
  openSession,
  PROBE_AGENT_ID,
  phase,
  probeProfile,
  removeDir,
  runScenario,
} from './harness.mjs';

const probe = probeProfile('typing');
const ESC = String.fromCharCode(27);

const xtermSize = (page, sid) =>
  page.evaluate((id) => {
    const t = window.__terms?.[id];
    return t ? `${t.cols}x${t.rows}` : null;
  }, sid);
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';
const typed = () =>
  probe
    .records('IN')
    .map((r) => r.data)
    .join('');

await runScenario(
  'typing-through-server',
  async ({ app, page, log }) => {
    const work = mkdtempSync(join(tmpdir(), 'conduit-typing-'));
    await page.evaluate(() => {
      window.__terms = {};
    });

    phase('open the probe');
    const sid = await openSession(page, { path: work, agentId: PROBE_AGENT_ID });
    assert(
      await until(() => probe.records('READY').length === 1, 20_000),
      `the probe never started: ${JSON.stringify(probe.records())}`,
    );
    assert(
      await until(async () => (await paneText(page, sid)).includes('PROBE-READY'), 15_000),
      'the pane never showed the probe',
    );
    // The program's own first size must already be the pane's (the server attaches at it).
    assert(
      await until(async () => {
        const last = probe.records().at(-1);
        return last?.size === (await xtermSize(page, sid));
      }, 10_000),
      `program size ${probe.records().at(-1)?.size} ≠ xterm ${await xtermSize(page, sid)}`,
    );

    phase('keystrokes');
    await page.evaluate((id) => window.__terms[id].focus(), sid);
    await page.keyboard.type('keys-1A2b', { delay: 20 });
    await page.keyboard.press('Enter');
    assert(
      await until(() => probe.records('LINE').some((r) => r.line === 'keys-1A2b'), 15_000),
      `typed keys never reached the program as one line: ${JSON.stringify(typed())}`,
    );
    assert(
      await until(async () => (await paneText(page, sid)).includes('PROBE-LINE keys-1A2b'), 10_000),
      'the pane never showed the echo of the typed line',
    );
    log('keystrokes ✓');

    phase('bracketed paste');
    await page.evaluate((id) => window.__terms[id].paste('paste-one\npaste-two'), sid);
    const wanted = `${ESC}[200~paste-one\rpaste-two${ESC}[201~`;
    assert(
      await until(() => typed().includes(wanted), 15_000),
      `the paste did not arrive bracketed: ${JSON.stringify(typed().slice(-120))}`,
    );
    log('bracketed paste ✓');

    phase('resize');
    const before = await xtermSize(page, sid);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const [width, height] = w.getSize();
      w.setSize(width - 240, height - 160);
    });
    assert(
      await until(async () => (await xtermSize(page, sid)) !== before, 10_000),
      `the xterm never refit after the window resize (still ${before})`,
    );
    // Let the refit settle (it may step), then read the program's size through a keystroke too.
    let after = await xtermSize(page, sid);
    await until(async () => {
      await sleep(500);
      const now = await xtermSize(page, sid);
      const settled = now === after;
      after = now;
      return settled;
    }, 5_000);
    await page.keyboard.type('z');
    assert(
      await until(() => probe.records('IN').at(-1)?.size === after, 15_000),
      `program size ${probe.records().at(-1)?.size} ≠ xterm ${after} after the resize (was ${before})`,
    );
    const sizes = probe.records('SIZE').map((r) => r.size);
    log(`resize ${before} → ${after}; program SIZE records: ${JSON.stringify(sizes)}`);
    assert(sizes.includes(after), `the program never saw a resize to ${after}: ${sizes}`);
    log('resize ✓');

    phase('cleanup');
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
    await until(
      () => page.evaluate((id) => !(window.__sessions || []).some((s) => s.id === id), sid),
      15_000,
    );
    await removeDir(work, { budgetMs: 10_000 });
  },
  { userDataDir: probe.userDataDir },
);

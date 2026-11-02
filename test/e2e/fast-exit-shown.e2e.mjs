/**
 * fast-exit-shown — a command that prints and exits at once is shown as an exited session with its
 * output (program W8; W7: a `finished` start is shown as exited with its output and no attach).
 * The program may end before the pane's first `sessions.start` reaches the server, so the output
 * only reaches the pane through the server's stored history, never a live stream.
 *   - the session ends `exited` with the program's exit code, and is kept (an agent, not a shell);
 *   - its pane shows the program's output and the exit line with that code.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  logicalLines,
  openSession,
  phase,
  probeProfile,
  removeDir,
  runScenario,
} from './harness.mjs';

const FAST_AGENT = 'e2e-fast-exit';
const OUTPUT = 'FAST-EXIT-OUTPUT-4217';
const probe = probeProfile('fast-exit', [
  {
    id: FAST_AGENT,
    label: 'Fast exit',
    command: process.execPath,
    args: ['-e', `process.stdout.write('${OUTPUT}\\r\\n');process.exitCode=3`],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
]);

const session = (page, id) =>
  page.evaluate((s) => (window.__sessions || []).find((x) => x.id === s) ?? null, id);
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';

await runScenario(
  'fast-exit-shown',
  async ({ page, log, userDataDir }) => {
    const work = mkdtempSync(join(tmpdir(), 'conduit-fast-exit-'));
    await page.evaluate(() => {
      window.__terms = {};
    });

    phase('open the fast-exiting command');
    const sid = await openSession(page, { path: work, agentId: FAST_AGENT });
    assert(
      await until(async () => (await session(page, sid))?.status === 'exited', 20_000),
      `the session never showed exited: ${JSON.stringify(await session(page, sid))}`,
    );
    const s = await session(page, sid);
    log(`session: status=${s.status} exitCode=${s.exitCode} spawn=${s.runtime?.spawn}`);
    assert(s.exitCode === 3, `exit code ${s.exitCode}, expected 3`);

    phase('server history');
    // The server's ring is what a finished start's prelude is painted from.
    const ring = join(userDataDir, `scrollback-${sid}.json`);
    assert(
      await until(() => existsSync(ring) && readFileSync(ring, 'utf8').includes(OUTPUT), 15_000),
      'the server never stored the output in its scrollback ring',
    );

    phase('pane');
    const shown = await until(async () => (await paneText(page, sid)).includes(OUTPUT), 15_000);
    if (!shown) {
      const view = await page.evaluate(
        (id) => ({
          paneMounted: !!window.__terms?.[id],
          card: document.querySelector('.session-stale__title')?.textContent ?? null,
        }),
        sid,
      );
      log(`no output in the pane; ${JSON.stringify(view)}`);
    }
    assert(shown, `the pane never showed the output: ${JSON.stringify(await paneText(page, sid))}`);
    assert(
      await until(
        async () => (await paneText(page, sid)).includes('[process exited with code 3]'),
        10_000,
      ),
      `the pane never showed the exit line: ${JSON.stringify(await paneText(page, sid))}`,
    );
    const text = await paneText(page, sid);
    assert(
      text.split(OUTPUT).length === 2,
      `the output is shown ${text.split(OUTPUT).length - 1} times, expected once: ${JSON.stringify(text)}`,
    );
    // An agent session that exits is kept with its output (only plain shells auto-close).
    assert(
      (await session(page, sid))?.status === 'exited',
      'the exited session did not stay in the list',
    );
    log('fast exit shown with its output ✓');

    phase('cleanup');
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
    await until(async () => (await session(page, sid)) === null, 15_000);
    await removeDir(work, { budgetMs: 10_000 });
  },
  { userDataDir: probe.userDataDir },
);

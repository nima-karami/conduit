/**
 * exited-pane-remount — an exited session's pane is unmounted while another session is shown, and
 * switching back remounts it with `term:start` mode 'view' (memory lane E): the same output and exit
 * line, with no respawn and nothing added to the server's ring.
 *   - A exits (output + exit line shown); B is opened and shown, and A's pane is unmounted;
 *   - back on A: its output once, the exit line, no relaunch marker;
 *   - A's program ran once, A stays exited, and its stored ring is byte-identical.
 */
import { existsSync, mkdtempSync, readFileSync, watch } from 'node:fs';
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
  revealSessionRow,
  runScenario,
} from './harness.mjs';

const AGENT = 'e2e-exit-remount';
const OUTPUT = 'EXITED-REMOUNT-OUTPUT-5381';
// Each run appends to spawns.txt in its own folder, so a respawn is counted, not inferred.
const probe = probeProfile('exited-pane-remount', [
  {
    id: AGENT,
    label: 'Exit remount',
    command: process.execPath,
    args: [
      '-e',
      `require('fs').appendFileSync('spawns.txt','x');process.stdout.write('${OUTPUT}\\r\\n');process.exitCode=3`,
    ],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
]);

const session = (page, id) =>
  page.evaluate((s) => (window.__sessions || []).find((x) => x.id === s) ?? null, id);
const paneText = async (page, sid) => (await logicalLines(page, sid))?.join('\n') ?? '';
const paneMounted = (page, sid) =>
  page.evaluate(
    (id) => !!window.__terms?.[id] || !!document.querySelector(`.termhost[data-sessionid="${id}"]`),
    sid,
  );
const spawnsIn = (dir) => {
  const f = join(dir, 'spawns.txt');
  return existsSync(f) ? readFileSync(f, 'utf8').length : 0;
};

async function openExited(page, work, log) {
  const sid = await openSession(page, { path: work, agentId: AGENT });
  assert(
    await until(async () => (await session(page, sid))?.status === 'exited', 20_000),
    `the session never showed exited: ${JSON.stringify(await session(page, sid))}`,
  );
  assert(
    await until(async () => {
      const t = await paneText(page, sid);
      return t.includes(OUTPUT) && t.includes('[process exited with code 3]');
    }, 15_000),
    `the pane never showed the output and exit line: ${JSON.stringify(await paneText(page, sid))}`,
  );
  log(`exited ${sid}`);
  return sid;
}

await runScenario(
  'exited-pane-remount',
  async ({ page, log, userDataDir }) => {
    const workA = mkdtempSync(join(tmpdir(), 'conduit-remount-a-'));
    const workB = mkdtempSync(join(tmpdir(), 'conduit-remount-b-'));
    await page.evaluate(() => {
      window.__terms = {};
    });

    phase('A exits with its output shown');
    const a = await openExited(page, workA, log);
    const ring = join(userDataDir, `scrollback-${a}.json`);
    assert(
      await until(() => existsSync(ring) && readFileSync(ring, 'utf8').includes(OUTPUT), 15_000),
      'the server never stored A’s output in its ring',
    );

    phase('B shown: A’s pane unmounts');
    const b = await openExited(page, workB, log);
    assert(
      await until(async () => !(await paneMounted(page, a)), 10_000),
      'A’s exited pane stayed mounted while B was shown',
    );
    // The ring's debounced write has long settled; this is what a view must leave untouched.
    const ringBefore = readFileSync(ring, 'utf8');

    phase('back to A: remounted in view mode');
    await revealSessionRow(page, a);
    await page.click(`[data-agent-tree] .session[data-sessionid="${a}"]`);
    assert(
      await until(async () => {
        const t = await paneText(page, a);
        return t.includes(OUTPUT) && t.includes('[process exited with code 3]');
      }, 15_000),
      `A’s remounted pane never showed its output and exit line: ${JSON.stringify(await paneText(page, a))}`,
    );
    const text = await paneText(page, a);
    assert(
      text.split(OUTPUT).length === 2,
      `A’s output is shown ${text.split(OUTPUT).length - 1} times, expected once: ${JSON.stringify(text)}`,
    );
    assert(!text.includes('session relaunched'), `A was relaunched: ${JSON.stringify(text)}`);
    assert(!(await paneMounted(page, b)), 'B’s exited pane stayed mounted while A was shown');

    phase('no respawn, no record');
    const watched = [
      [watch(workA, { signal: AbortSignal.timeout(1500) }), 'spawns.txt'],
      [watch(workB, { signal: AbortSignal.timeout(1500) }), 'spawns.txt'],
      [watch(userDataDir, { signal: AbortSignal.timeout(1500) }), `scrollback-${a}.json`],
    ];
    const unexpectedWrite = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        for (const [watcher] of watched) watcher.close();
        resolve(value);
      };
      for (const [watcher, target] of watched) {
        const onWrite = (_event, filename) => {
          if (String(filename) === target) finish(target);
        };
        watcher.on('change', onWrite);
        watcher.on('rename', onWrite);
        watcher.on('error', (error) => {
          if (error.name === 'AbortError') finish(null);
          else finish(error);
        });
      }
    });
    assert(!unexpectedWrite, `viewing an exited pane wrote ${unexpectedWrite}`);
    assert(spawnsIn(workA) === 1, `A's program ran ${spawnsIn(workA)} times, expected once`);
    assert(spawnsIn(workB) === 1, `B's program ran ${spawnsIn(workB)} times, expected once`);
    assert((await session(page, a))?.status === 'exited', 'A did not stay exited');
    assert(readFileSync(ring, 'utf8') === ringBefore, 'viewing A changed its stored ring');
    log('exited pane remounted without a respawn ✓');

    phase('cleanup');
    for (const id of [a, b]) {
      await page.evaluate((x) => window.agentDeck.post({ type: 'kill', id: x }), id);
      await until(async () => (await session(page, id)) === null, 15_000);
    }
    await removeDir(workA, { budgetMs: 10_000 });
    await removeDir(workB, { budgetMs: 10_000 });
  },
  { userDataDir: probe.userDataDir },
);

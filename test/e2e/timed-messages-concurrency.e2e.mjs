/**
 * Timed messages, the concurrency and window-state edge cases (spec 2026-08-28-timed-messages §7).
 *
 * The scheduler serialises deliveries PER SESSION and nothing across sessions, and its clock is a
 * plain main-process `setTimeout` that knows nothing about window visibility. Both are claims only
 * the built app can settle, because the garbling this guards against happens in the PTY, not in
 * the schedule set:
 *
 *   A. Two sessions due in ONE evaluate() pass — each shell gets its own message and its own
 *      Enter, and neither ever sees the other's text.
 *   B. The window MINIMIZED — the fire still lands, asserted without restoring the window.
 *   C. A BACKGROUNDED session (its pane mounted but hidden while the other tab is selected) —
 *      the host timer does not depend on which pane the renderer is showing.
 *
 * Each assertion reads what the real shell actually received: a PowerShell stdin reader per
 * session dumps whether its OWN message, the Enter, and the OTHER session's message arrived. A
 * cross-delivery therefore shows up as `other=True` in a dump, not as a missing event.
 *
 * Windows only. Run it ALONE on a quiet machine: leftover cmd.exe/conhost starves ConPTY and
 * makes every PTY-adjacent scenario look broken (CLAUDE.md).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[timed-messages-concurrency] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('timed-messages-concurrency');

const ALPHA = 'conduit-par-alpha';
const BRAVO = 'conduit-par-bravo';
/**
 * Ends a reader phase. It carries a CR of its own because ConPTY hands a console app its input a
 * LINE at a time — a CR-less marker never reaches the reader at all — so the Enter is asserted as
 * `<message>CR`, which the phase marker cannot fake.
 */
const EOF_TOKEN = 'conduit-eof-now';

/**
 * A reader that echoes READY, swallows its session's stdin until the phase ends, then reports
 * what landed: its own message, the submit, and — the cross-delivery probe — the other session's.
 */
const reader = (mine, other) => `$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine("READY")
$in  = [Console]::OpenStandardInput()
$buf = New-Object byte[] 4096
$acc = New-Object System.Collections.Generic.List[byte]
while ($true) {
  $n = $in.Read($buf, 0, $buf.Length)
  if ($n -le 0) { break }
  for ($i = 0; $i -lt $n; $i++) { $acc.Add($buf[$i]) }
  $s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
  if ($s.Contains("${EOF_TOKEN}")) { break }
}
$s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
$submitted = '${mine}' + [char]13
"mine=$($s.Contains('${mine}')) enter=$($s.Contains($submitted)) other=$($s.Contains('${other}'))" | Out-File $env:DUMP -Encoding ascii
`;

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-parallel-'));
const workA = mkdtempSync(join(tmpdir(), 'conduit-par-a-'));
const workB = mkdtempSync(join(tmpdir(), 'conduit-par-b-'));

const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
    // The 30 s arming floor and the clock seam are both gated on it (§7), and it launches the
    // window hidden — which is NOT the same as minimized, the state scenario B drives explicitly.
    env: { ...process.env, CONDUIT_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  // Per-SESSION output: window.__cap merges both terminals, which cannot answer "did session A's
  // shell see session B's message".
  await page.evaluate(() => {
    // Opt-in pane registry (terminal-pane.tsx): proves session B's pane is MOUNTED while hidden.
    window.__terms = window.__terms || {};
    window.__fires = [];
    window.__timers = null;
    window.__bySession = {};
    window.agentDeck.subscribe((m) => {
      if (m.type === 'term:data') {
        window.__bySession[m.sessionId] = (window.__bySession[m.sessionId] || '') + m.data;
      }
      if (m.type === 'timer:fired') window.__fires.push(m);
      if (m.type === 'timer:state') window.__timers = m;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  return { app, page };
}

const armIn = (page, sessionId, message, delayMs) =>
  page.evaluate(
    ({ sid, msg, ms }) =>
      window.agentDeck.post({
        type: 'timer:set',
        schedule: { sessionId: sid, message: msg, trigger: { kind: 'in', delayMs: ms } },
      }),
    { sid: sessionId, msg: message, ms: delayMs },
  );

const capLen = (page, sid) => page.evaluate((s) => (window.__bySession[s] || '').length, sid);

/**
 * Per-session output offsets, taken BEFORE a phase ends: the shell reprints its prompt the moment
 * the reader exits, so an offset taken afterwards looks past it and waits forever.
 */
const capMarks = async (page, sids) => {
  const marks = {};
  for (const s of sids) marks[s] = await capLen(page, s);
  return marks;
};

const deliveredTo = (page, sid) =>
  page.evaluate(
    (s) => (window.__fires || []).filter((f) => f.sessionId === s && f.delivered).length,
    sid,
  );

/** Wait for the shell to print its prompt again — typing before it does loses the input. */
const waitForPrompt = (page, sid, dir, from = 0) =>
  page.waitForFunction(
    ({ s, d, at }) => (window.__bySession[s] || '').slice(at).includes(`${d}>`),
    { s: sid, d: dir, at: from },
    { timeout: 30000 },
  );

async function startReader(page, sid, { mine, other, dumpPath }) {
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'conduit-par-reader-')), 'reader.ps1');
  writeFileSync(scriptPath, reader(mine, other));
  writeFileSync(dumpPath, '');
  const from = await capLen(page, sid);
  await page.evaluate(
    ({ s, script, dump }) => {
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: `set "DUMP=${dump}" && powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"\r`,
      });
    },
    { s: sid, script: scriptPath.replace(/\\/g, '/'), dump: dumpPath.replace(/\\/g, '/') },
  );
  await page.waitForFunction(
    ({ s, at }) => (window.__bySession[s] || '').slice(at).includes('READY'),
    { s: sid, at: from },
    { timeout: 30000 },
  );
  await page.waitForTimeout(900); // let xterm process ESC[?2004h
}

const endReaders = (page, sids) =>
  page.evaluate(
    ({ list, eof }) => {
      for (const s of list) {
        window.agentDeck.post({ type: 'term:input', sessionId: s, data: `${eof}\r` });
      }
    },
    { list: sids, eof: EOF_TOKEN },
  );

async function readDump(path) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = readFileSync(path, 'utf8');
    if (/mine=/.test(text)) return text.trim();
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the reader never wrote its dump: ${path}`);
}

const dumpPath = (tag) => join(mkdtempSync(join(tmpdir(), `conduit-par-dump-${tag}-`)), 'd.txt');

let launched;
try {
  launched = await launch();
  const { app, page } = launched;

  const sidA = await openSession(page, { path: workA.replace(/\\/g, '/') });
  await waitForPrompt(page, sidA, workA);
  const sidB = await openSession(page, { path: workB.replace(/\\/g, '/') });
  await waitForPrompt(page, sidB, workB);
  log('two sessions running:', sidA, sidB);

  // ── A. Both sessions due in ONE evaluate() pass ─────────────────────────────
  const dumpA1 = dumpPath('a1');
  const dumpB1 = dumpPath('b1');
  await startReader(page, sidA, { mine: ALPHA, other: BRAVO, dumpPath: dumpA1 });
  await startReader(page, sidB, { mine: BRAVO, other: ALPHA, dumpPath: dumpB1 });

  await armIn(page, sidA, ALPHA, 60_000);
  await armIn(page, sidB, BRAVO, 60_000);
  await page.waitForFunction(
    ({ a, b }) => {
      const s = window.__timers?.schedules ?? [];
      return s.some((x) => x.sessionId === a) && s.some((x) => x.sessionId === b);
    },
    { a: sidA, b: sidB },
    { timeout: 10000 },
  );

  // ONE clock jump, so both are due inside the same synchronous evaluate() pass — two deliveries
  // in flight at once, which is the only way to reach the cross-session interleave.
  await page.evaluate(() =>
    window.agentDeck.post({ type: 'timer:test', op: 'advance', ms: 60_000 }),
  );
  await page.waitForFunction(
    ({ a, b }) => {
      const f = (window.__fires || []).filter((x) => x.delivered);
      return f.some((x) => x.sessionId === a) && f.some((x) => x.sessionId === b);
    },
    { a: sidA, b: sidB },
    { timeout: 30000 },
  );
  await page.evaluate(() =>
    window.agentDeck.post({ type: 'timer:test', op: 'advance', ms: -60_000 }),
  );

  const marks1 = await capMarks(page, [sidA, sidB]);
  await endReaders(page, [sidA, sidB]);
  const gotA1 = await readDump(dumpA1);
  const gotB1 = await readDump(dumpB1);
  assert(/mine=True/i.test(gotA1), `session A never received its own message: ${gotA1}`);
  assert(/enter=True/i.test(gotA1), `session A never received the Enter: ${gotA1}`);
  assert(/other=False/i.test(gotA1), `session A received session B's message: ${gotA1}`);
  assert(/mine=True/i.test(gotB1), `session B never received its own message: ${gotB1}`);
  assert(/enter=True/i.test(gotB1), `session B never received the Enter: ${gotB1}`);
  assert(/other=False/i.test(gotB1), `session B received session A's message: ${gotB1}`);
  const firesA = await deliveredTo(page, sidA);
  const firesB = await deliveredTo(page, sidB);
  assert(firesA === 1, `session A must fire exactly once, got ${firesA}`);
  assert(firesB === 1, `session B must fire exactly once, got ${firesB}`);
  log('A ✓ two sessions fired in one pass, each PTY got only its own message + Enter');

  // ── C. A backgrounded session still fires ───────────────────────────────────
  await waitForPrompt(page, sidA, workA, marks1[sidA]);
  await waitForPrompt(page, sidB, workB, marks1[sidB]);

  await page.locator(`[data-sessionid="${sidA}"]`).first().click();
  await page.waitForFunction(
    (a) => document.querySelector('.session--active')?.getAttribute('data-sessionid') === a,
    sidA,
    { timeout: 10000 },
  );
  const panes = await page.evaluate(
    (b) => ({
      visible: [...document.querySelectorAll('.termstack .termhost')].filter(
        (h) => getComputedStyle(h).display !== 'none',
      ).length,
      backgroundMounted: !!window.__terms?.[b],
    }),
    sidB,
  );
  assert(panes.backgroundMounted, 'session B pane must stay mounted while it is backgrounded');
  assert(panes.visible === 1, `only the selected pane may be visible, got ${panes.visible}`);
  log('session A selected; session B is running but backgrounded ✓');

  const dumpA2 = dumpPath('a2');
  const dumpB2 = dumpPath('b2');
  await startReader(page, sidA, { mine: ALPHA, other: BRAVO, dumpPath: dumpA2 });
  await startReader(page, sidB, { mine: BRAVO, other: ALPHA, dumpPath: dumpB2 });
  // Selecting A moved focus to A's pane; B must stay the background tab for the whole fire.
  await page.locator(`[data-sessionid="${sidA}"]`).first().click();

  const beforeB = await deliveredTo(page, sidB);
  await armIn(page, sidB, BRAVO, 2500);
  await page.waitForFunction(
    ({ b, n }) => (window.__fires || []).filter((f) => f.sessionId === b && f.delivered).length > n,
    { b: sidB, n: beforeB },
    { timeout: 30000 },
  );
  const stillActive = await page.evaluate(
    () => document.querySelector('.session--active')?.getAttribute('data-sessionid') ?? '',
  );
  assert(stillActive === sidA, `session A must still be the selected tab, got ${stillActive}`);

  const marks2 = await capMarks(page, [sidA, sidB]);
  await endReaders(page, [sidA, sidB]);
  const gotB2 = await readDump(dumpB2);
  const gotA2 = await readDump(dumpA2);
  assert(/mine=True/i.test(gotB2), `the backgrounded session never got its message: ${gotB2}`);
  assert(/enter=True/i.test(gotB2), `the backgrounded session never got the Enter: ${gotB2}`);
  assert(/mine=False/i.test(gotA2), `the foreground session was written to: ${gotA2}`);
  assert(/other=False/i.test(gotA2), `the backgrounded session's message went to A: ${gotA2}`);
  assert(/enter=False/i.test(gotA2), `the foreground session was submitted into: ${gotA2}`);
  log('C ✓ a backgrounded session fires into its own PTY while another tab is selected');

  // ── B. The window minimized ─────────────────────────────────────────────────
  await waitForPrompt(page, sidA, workA, marks2[sidA]);
  await waitForPrompt(page, sidB, workB, marks2[sidB]);

  const dumpA3 = dumpPath('a3');
  const dumpB3 = dumpPath('b3');
  await startReader(page, sidA, { mine: ALPHA, other: BRAVO, dumpPath: dumpA3 });
  await startReader(page, sidB, { mine: BRAVO, other: ALPHA, dumpPath: dumpB3 });

  const beforeA = await deliveredTo(page, sidA);
  // Long enough that the minimize below lands well before the fire does.
  await armIn(page, sidA, ALPHA, 6000);
  await page.waitForFunction(
    (a) => (window.__timers?.schedules ?? []).some((s) => s.sessionId === a && s.state === 'armed'),
    sidA,
    { timeout: 10000 },
  );

  const minimized = await app.evaluate((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    win.minimize();
    // Under CONDUIT_E2E the window was created with show:false, and a window that was never shown
    // cannot be iconified — show it only so it can immediately go to the taskbar.
    if (!win.isMinimized()) {
      win.show();
      win.minimize();
    }
    return win.isMinimized();
  });
  assert(minimized === true, 'the window did not actually minimize');
  log('window minimized ✓');

  await page.waitForFunction(
    ({ a, n }) => (window.__fires || []).filter((f) => f.sessionId === a && f.delivered).length > n,
    { a: sidA, n: beforeA },
    { timeout: 40000 },
  );
  await endReaders(page, [sidA, sidB]);
  const gotA3 = await readDump(dumpA3);
  const gotB3 = await readDump(dumpB3);
  // Read the window state BEFORE anything can restore it: an assertion made after a restore
  // would prove only that the fire happened, not that it happened while minimized.
  const stillMinimized = await app.evaluate(
    (electron) => electron.BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false,
  );
  assert(stillMinimized === true, 'the window was restored before the assertion');
  assert(/mine=True/i.test(gotA3), `the minimized-window fire never reached the shell: ${gotA3}`);
  assert(/enter=True/i.test(gotA3), `the minimized-window fire never submitted: ${gotA3}`);
  assert(/mine=False/i.test(gotB3), `the other session was written to: ${gotB3}`);
  assert(/other=False/i.test(gotB3), `session A's message went to session B: ${gotB3}`);
  log('B ✓ the schedule fired into the real PTY with the window minimized');

  await closeApp(app, page);
  launched = null;

  log('PASS ✓ all assertions passed');
  process.exit(0);
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[timed-messages-concurrency] FAIL ✗', e.message);
  } else {
    console.error('[timed-messages-concurrency] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    // closeApp, not app.close(): a window owning running sessions makes the host ask for a quit
    // decision and wait for the answer, so a bare close hangs (harness.mjs closeApp).
    if (launched) await closeApp(launched.app, launched.page);
  } catch {
    /* already gone */
  }
  process.exit(e?.name === 'AssertionError' ? 1 : 2);
}

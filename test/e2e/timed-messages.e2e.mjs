/**
 * Timed messages (real-app smoke, spec 2026-08-28-timed-messages §7).
 *
 * Crosses the renderer/host boundary AND the PTY: the schedule, the clock and the write all live
 * in the main process, and the preview bridge has no PTY at all — so only the built app proves it.
 *
 * Launch 1: on-time delivery (byte-exact, via a stdin reader), interval repeats (via the
 *           CONDUIT_E2E clock seam), a chip screenshot, then arm one and quit.
 * Launch 2: the same profile — restored as `waiting` with nothing written, then the ordinary
 *           relaunch path delivers it once, late.
 *
 * Windows only. Run it ALONE on a quiet machine: leftover cmd.exe/conhost starves ConPTY and
 * makes every PTY-adjacent scenario look broken (CLAUDE.md).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  runShellReader,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[timed-messages] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('timed-messages');

/** A reader that echoes READY, then dumps whether the payload AND the Enter both arrived. */
const READER = `$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine("READY")
$in  = [Console]::OpenStandardInput()
$buf = New-Object byte[] 4096
$acc = New-Object System.Collections.Generic.List[byte]
while ($true) {
  $n = $in.Read($buf, 0, $buf.Length)
  if ($n -le 0) { break }
  for ($i = 0; $i -lt $n; $i++) { $acc.Add($buf[$i]) }
  $s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
  if ($s.Contains("conduit-timed-ok") -and $s.Contains([char]13)) { break }
}
$s = -join ($acc.ToArray() | ForEach-Object { [char]$_ })
"text=$($s.Contains('conduit-timed-ok')) enter=$($s.Contains([char]13))" | Out-File $env:DUMP -Encoding ascii
`;

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-timed-'));
const workDir = mkdtempSync(join(tmpdir(), 'conduit-timed-work-'));
const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
mkdirSync(shotDir, { recursive: true });

const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  // Timer traffic, captured from the moment the window is live.
  await page.evaluate(() => {
    window.__fires = [];
    window.__timers = null;
    window.agentDeck.subscribe((m) => {
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

const schedules = (page) => page.evaluate(() => window.__timers?.schedules ?? []);

let first;
let second;
try {
  // ── Launch 1 ────────────────────────────────────────────────────────────────
  first = await launch();
  const { page } = first;
  const sid = await openSession(page, { path: workDir.replace(/\\/g, '/') });
  log('session running:', sid);

  // openSession returns as soon as the session lands in state — which is BEFORE cmd.exe has
  // initialised its console, and ConPTY drops anything written into it until then. Wait for the
  // prompt itself; a sleep here is what made this scenario flaky.
  await page.waitForFunction((dir) => (window.__cap || '').includes(`${dir}>`), workDir, {
    timeout: 30000,
  });

  // ── On-time delivery, byte-exact ────────────────────────────────────────────
  const dump = join(mkdtempSync(join(tmpdir(), 'conduit-timed-dump-')), 'd.txt');
  writeFileSync(dump, '');
  await runShellReader(page, sid, { script: READER, dumpPath: dump });
  log('stdin reader is up ✓');

  const activeBefore = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.lastActiveAt ?? 0,
    sid,
  );

  // The MIN_DELAY_MS floor is 0 under CONDUIT_E2E, so +800 ms is a legal schedule (§7).
  await armIn(page, sid, 'conduit-timed-ok', 800);
  await page.waitForFunction(() => (window.__fires || []).some((f) => f.delivered), null, {
    timeout: 20000,
  });
  const onTime = await page.evaluate(() => window.__fires[0]);
  assert(onTime.delivered === true, 'the on-time fire must report delivered');
  assert(onTime.late === false, `an on-time fire must not be late (got ${JSON.stringify(onTime)})`);

  const dumped = readFileSync(dump, 'utf8');
  assert(/text=True/i.test(dumped), `the shell did not receive the message: ${dumped}`);
  assert(/enter=True/i.test(dumped), `the shell did not receive the Enter: ${dumped}`);
  log('message AND Enter both reached the real shell ✓');

  // A fire is not the user at the keyboard: lastActiveAt must not move (§2 "Delivery").
  const activeAfter = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.lastActiveAt ?? 0,
    sid,
  );
  assert(
    activeAfter === activeBefore,
    `a fire must not touch lastActiveAt (${activeBefore} -> ${activeAfter})`,
  );
  log('lastActiveAt untouched by the fire ✓');

  // ── Interval repeats stop at the limit ──────────────────────────────────────
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'timer:set',
        schedule: {
          sessionId: id,
          message: 'echo conduit-interval',
          // A MINUTE, advanced a minute at a time. The interval has to be far longer than the
          // real time each round trip costs: catchUp measures `now - nextAt`, so with a 1 s
          // interval the ~1 s spent delivering and asserting counts as a second elapsed slot and
          // two intervals collapse into one delivery — correct behaviour, wrong test.
          trigger: { kind: 'every', everyMs: 60_000, maxRepeats: 3 },
        },
      }),
    sid,
  );
  await page.waitForFunction(
    () => (window.__timers?.schedules ?? []).some((s) => s.kind === 'interval'),
    null,
    { timeout: 10000 },
  );
  const intervalId = (await schedules(page)).find((s) => s.kind === 'interval').id;

  // Four intervals in milliseconds of real time, not four minutes — the CONDUIT_E2E clock seam (§7).
  // Each advance waits on ITS OWN observable effect rather than a sleep: two sleeps that both
  // land inside one host turn would collapse two intervals into one delivery and the scenario
  // would still read "3 fires", passing for the wrong reason.
  const firesFor = (id) =>
    page.evaluate((x) => (window.__fires || []).filter((f) => f.id === x).length, id);
  const ADVANCE_MS = 60_000;
  let advanced = 0;
  for (let i = 0; i < 4; i++) {
    const before = await firesFor(intervalId);
    await page.evaluate(
      (ms) => window.agentDeck.post({ type: 'timer:test', op: 'advance', ms }),
      ADVANCE_MS,
    );
    advanced += ADVANCE_MS;
    // The fourth advance is past maxRepeats, so it must produce NO fourth fire — wait for the
    // schedule to be done instead of for a count that will never arrive.
    if (before >= 3) {
      await page.waitForFunction(
        (id) => (window.__timers?.schedules ?? []).find((s) => s.id === id)?.state === 'done',
        intervalId,
        { timeout: 20000 },
      );
      continue;
    }
    await page.waitForFunction(
      ({ id, n }) => (window.__fires || []).filter((f) => f.id === id).length > n,
      { id: intervalId, n: before },
      { timeout: 20000 },
    );
  }
  assert(
    (await firesFor(intervalId)) === 3,
    'an interval with 3 repeats must deliver exactly 3 times',
  );
  const done = (await schedules(page)).find((s) => s.id === intervalId);
  assert(done.state === 'done', `interval must stop at maxRepeats, got ${done.state}`);
  assert(done.firedCount === 3, `interval must fire exactly 3 times, got ${done.firedCount}`);
  const cap = await page.evaluate(() => window.__cap || '');
  assert(cap.includes('conduit-interval'), 'the interval message never reached the shell');
  log('interval fired 3 times and stopped ✓');

  // ── The chip ────────────────────────────────────────────────────────────────
  await armIn(page, sid, 'conduit-chip', 30 * 60_000);
  await page.locator('.term-timer').first().waitFor({ state: 'visible', timeout: 10000 });
  const chipText = (await page.locator('.term-timer').first().innerText()).trim();
  assert(/\bin \d+/.test(chipText), `the chip must count down, got "${chipText}"`);
  await page.screenshot({ path: join(shotDir, 'timed-messages-chip.png') }).catch(() => {});
  log(`chip reads "${chipText}" ✓`);

  const chipId = (await schedules(page)).find((s) => s.message === 'conduit-chip').id;
  await page.evaluate((id) => window.agentDeck.post({ type: 'timer:cancel', id }), chipId);
  await page.waitForFunction(
    (id) => !(window.__timers?.schedules ?? []).some((s) => s.id === id),
    chipId,
    { timeout: 10000 },
  );

  // ── Arm one that will come due while the app is closed, then quit ───────────
  // Put the injected clock back first. The offset is host memory that dies with the process, but
  // `nextAt` is written to DISK with it applied — so a schedule armed while the clock is four
  // minutes ahead comes back four minutes from due, and the restart assertion would wait for a
  // `waiting` state that is still minutes away.
  await page.evaluate(
    (ms) => window.agentDeck.post({ type: 'timer:test', op: 'advance', ms }),
    -advanced,
  );
  advanced = 0;

  await armIn(page, sid, 'echo conduit-timed-late', 8000);
  await page.waitForFunction(
    () => (window.__timers?.schedules ?? []).some((s) => s.message === 'echo conduit-timed-late'),
    null,
    { timeout: 10000 },
  );
  await closeApp(first.app, page);
  first = null;
  log('app closed with a schedule armed ✓');

  // ── Launch 2: restored as waiting, with nothing written ─────────────────────
  second = await launch();
  const page2 = second.page;

  // No session is running after a restore, so this can only settle on `waiting` — whether it
  // came due while the app was closed or a moment after it came back.
  const waiting = await page2
    .waitForFunction(
      () =>
        (window.__timers?.schedules ?? []).find(
          (s) => s.message === 'echo conduit-timed-late' && s.state === 'waiting',
        ) || null,
      null,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue());
  assert(waiting, 'the schedule did not come back as waiting');
  assert(
    typeof waiting.waitingSince === 'number',
    'a waiting schedule must record when it came due',
  );
  assert(
    (await page2.evaluate(() => (window.__fires || []).length)) === 0,
    'nothing may be delivered while the session has no PTY',
  );
  assert(
    !(await page2.evaluate(() => window.__cap || '')).includes('conduit-timed-late'),
    'nothing may be written to any terminal while the session is stale',
  );
  log('restored as waiting, nothing written ✓');

  // The stale card is the ACTIVE session's; after a restore that is whichever session the rail
  // sorted first, so select the one the schedule belongs to the way a user would.
  const waitingName = await page2.evaluate(
    (id) => (window.__sessions || []).find((x) => x.id === id)?.name ?? '',
    waiting.sessionId,
  );
  await page2.locator('.session', { hasText: waitingName }).first().click();
  await page2.locator('.stale__waiting').first().waitFor({ state: 'visible', timeout: 15000 });
  const waitingText = (await page2.locator('.stale__waiting').first().innerText()).trim();
  assert(/waiting/i.test(waitingText), `the stale card must say Waiting, got "${waitingText}"`);
  log(`stale card reads "${waitingText}" ✓`);

  // ── The ordinary "user opens the session" path delivers it, once, late ──────
  await page2.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), waiting.sessionId);
  await page2.waitForFunction(() => (window.__fires || []).length > 0, null, { timeout: 60000 });
  const fires = await page2.evaluate(() => window.__fires);
  assert(fires.length === 1, `exactly one late delivery, got ${fires.length}`);
  assert(fires[0].delivered === true, 'the catch-up fire must report delivered');
  assert(fires[0].late === true, 'a catch-up fire must be marked late');

  // The real shell echoes what was typed: the command line AND its output.
  await page2.waitForFunction(
    () => ((window.__cap || '').match(/conduit-timed-late/g) || []).length >= 2,
    null,
    { timeout: 30000 },
  );
  const hits = await page2.evaluate(
    () => ((window.__cap || '').match(/conduit-timed-late/g) || []).length,
  );
  assert(hits === 2, `expected the typed line and its echo exactly once each, got ${hits}`);
  log('shell echoed the late message exactly once ✓');

  // The toast says it was late.
  const toast = (await page2.locator('.toast__msg').first().innerText()).trim();
  assert(/late/i.test(toast), `the toast must mark the send as late, got "${toast}"`);
  log(`toast reads "${toast}" ✓`);

  await closeApp(second.app, page2);
  second = null;

  log('PASS ✓ all assertions passed');
  process.exit(0);
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[timed-messages] FAIL ✗', e.message);
  } else {
    console.error('[timed-messages] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  for (const launched of [first, second]) {
    try {
      // closeApp, not app.close(): a window owning a running session makes the host ask for a
      // quit decision and wait for the answer, so a bare close hangs until the runner kills it
      // and the real failure is buried under a timeout (see harness.mjs closeApp).
      if (launched) await closeApp(launched.app, launched.page);
    } catch {
      /* already gone */
    }
  }
  process.exit(e?.name === 'AssertionError' ? 1 : 2);
}

import {
  assert,
  clearSpyCalls,
  finishScenario,
  getSpyCalls,
  launchApp,
  makeLog,
  openSession,
  REPO,
  setWindowFocus,
  spyMain,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[attention] SKIP — suite is Windows-only');
  await finishScenario(0);
}

// Attention routing hinges on real window focus/blur semantics, so it needs a
// visible, focusable window — opt out of the suite's hidden-window mode (the
// terminal output the test drives never arrives against a hidden window here).
delete process.env.CONDUIT_E2E;

const log = makeLog('attention');

// Maximum wait for needsAttention (the renderer-visible arm) after a qualifying run.
// The activity sweep fires every 750ms and attention needs ATTENTION_QUIET_MS (4s) of
// silence; under load the sweep can be delayed, so the ceiling is 20s.
const FLASH_POLL_TIMEOUT_MS = 20000;
// SPAWN_GRACE_MS (5s) plus margin: output before this is startup noise, not evidence.
// STOP (CON-134): no session field exposes spawn-grace expiry; see report.
const SPAWN_GRACE_WAIT_MS = 6500;
// A run that QUALIFIES as evidence (>= MIN_RUN_BYTES in one burst). A bare `echo` no
// longer arms attention — that trivial signal is what the 2026-08-21 spec set out to
// kill; see docs/specs/archive/2026-08-21-attention-signal-quality.md.
const BUSY_PAYLOAD = `node -e "process.stdout.write('conduit-busy'+'-test'+'x'.repeat(4000)+String.fromCharCode(10))"\r`;

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  // Install spies before any output arrives.
  await spyMain(app, [
    { api: 'Notification' },
    { api: 'flashFrame' },
    { api: 'setOverlayIcon' },
    { api: 'setBadgeCount' },
  ]);

  await tapBridge(page);
  // Two sessions: a session the user can SEE never needs attention, so the run is driven
  // in the BACKGROUND sidA while sidB is the one on screen. (A single visible session can
  // never raise its own attention.)
  const sidA = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  const sidB = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  /** Bounded window for a negative: a second qualifying run must not re-flash. */
  const observeNothingFor = async (ms, check) => {
    await page.waitForTimeout(ms);
    return check();
  };

  const waitNeedsAttention = (sid, timeout = FLASH_POLL_TIMEOUT_MS) =>
    page.waitForFunction(
      (id) => !!(window.__sessions || []).find((s) => s.id === id)?.needsAttention,
      sid,
      { timeout },
    );

  // Report sidB as this window's visible session, leaving sidA in the background.
  const setVisible = async (ids) => {
    await page.evaluate((v) => window.agentDeck.post({ type: 'visible', ids: v }), ids);
    // STOP (CON-134): visible is applied on the server via coalesced ui.presence; nothing
    // in __sessions / the sidebar reflects the host-visible set (see report).
    await page.waitForTimeout(500);
  };
  await setVisible([sidB]);

  // Wait for initial shell prompt (some output).
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });
  // Both sessions were just spawned; wait out the grace so the banners are not mistaken
  // for work and the run below is the only evidence in play.
  await page.waitForTimeout(SPAWN_GRACE_WAIT_MS);

  // ── Part 1: blurred window + background busy→idle edge should raise attention ──

  // Blur the window so osAttention fires.
  await setWindowFocus(app, false);
  await clearSpyCalls(app);

  // Send a command that produces output (making the session "busy"), then stop.
  // The activity sweep will detect idle after ~3s and raise attention.
  await page.evaluate(
    ({ s, cmd }) => {
      window.__cap = '';
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: cmd });
    },
    { s: sidA, cmd: BUSY_PAYLOAD },
  );

  // Wait for some output (session went busy).
  await page.waitForFunction(() => window.__cap.includes('conduit-busy-test'), null, {
    timeout: 15000,
  });

  // Log focus state so we can diagnose blur failures.
  const focusedBeforePoll = await app.evaluate((electron) => {
    const { BrowserWindow } = electron;
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.isFocused() : null;
  });
  log('window isFocused after blur:', focusedBeforePoll);

  log('session is busy — waiting for needsAttention (sweep idle → OS flash in the same turn)...');
  await waitNeedsAttention(sidA);
  const callsAfterBlur = await getSpyCalls(app);
  log(
    'spy calls after blur+busy→idle:',
    JSON.stringify(callsAfterBlur.map((c) => ({ api: c.api, args: c.args }))),
  );

  // On Windows, flashFrame is the most reliable attention signal. Notification
  // requires OS notification support — assert it if present, tolerate if not
  // (some headless/CI-like environments suppress notifications).
  const flashTrue = callsAfterBlur.find((c) => c.api === 'flashFrame' && c.args[0] === true);
  assert(flashTrue, 'Expected flashFrame(true) when window is blurred and session goes idle');
  log('PASS: flashFrame(true) recorded ✓');

  const notifCall = callsAfterBlur.find((c) => c.api === 'Notification');
  if (notifCall) {
    log('PASS: Notification recorded ✓', notifCall.args[0]);
  } else {
    log(
      'NOTE: Notification not recorded (may be suppressed on this machine — flashFrame is the gate)',
    );
  }

  // ── Part 2: re-focus should clear the flash ─────────────────────────────────
  await clearSpyCalls(app);
  await setWindowFocus(app, true);

  // setWindowFocus emits 'focus' in the same main-process turn as flashFrame(false).
  const callsAfterFocus = await getSpyCalls(app);
  log(
    'spy calls after focus:',
    JSON.stringify(callsAfterFocus.map((c) => ({ api: c.api, args: c.args }))),
  );

  const flashFalse = callsAfterFocus.find((c) => c.api === 'flashFrame' && c.args[0] === false);
  assert(flashFalse, 'Expected flashFrame(false) when window regains focus');
  log('PASS: flashFrame(false) on focus ✓');

  // ── Part 3: focused window + a finished run should NOT raise attention ──────
  // Acknowledge sidA first (Part 1 armed it, and the episode latch would suppress the
  // next edge on its own — this makes the window-focus gate the only thing under test).
  await setVisible([sidA]);
  await setVisible([sidB]);
  await clearSpyCalls(app);
  // Window is now focused. Drive another qualifying run; the sweep arms attention but
  // shouldRaiseOsAttention returns false because windowFocused = true.
  await page.evaluate(
    ({ s, cmd }) => {
      window.__cap = '';
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: cmd });
    },
    { s: sidA, cmd: BUSY_PAYLOAD },
  );
  await page.waitForFunction(() => window.__cap.includes('conduit-busy-test'), null, {
    timeout: 15000,
  });
  // Sweep still arms needsAttention; OS flash is gated off because the window is focused.
  await waitNeedsAttention(sidA);
  const callsWhileFocused = await getSpyCalls(app);
  const flashTrueWhileFocused = callsWhileFocused.find(
    (c) => c.api === 'flashFrame' && c.args[0] === true,
  );
  assert(!flashTrueWhileFocused, 'flashFrame(true) must NOT fire when window is focused');
  log('PASS: no attention raised while window is focused ✓');

  // ── Part 4: a session must notify only ONCE per unacknowledged episode ───────
  // An agent/terminal that keeps emitting output cycles busy→idle repeatedly; each idle
  // used to look like a fresh "finished" edge and re-raise attention (the reported bug:
  // the notification kept firing over and over). It must raise once and stay quiet until
  // the user acknowledges by LOOKING at the session — window focus is not that.

  // Acknowledge sidA (Parts 1/3 armed it), then put it back in the background.
  await setVisible([sidA]);
  await setVisible([sidB]);

  await setWindowFocus(app, false);
  await clearSpyCalls(app);

  const driveQualifyingRun = async (marker) => {
    await page.evaluate(
      ({ s, cmd }) => {
        window.__cap = '';
        window.agentDeck.post({ type: 'term:input', sessionId: s, data: cmd });
      },
      // The marker is split so the shell's echo of the command line cannot satisfy the
      // wait below, and the payload is big enough to qualify as a real run.
      {
        s: sidA,
        cmd: `node -e "process.stdout.write('${marker.slice(0, -1)}'+'${marker.slice(-1)}'+'x'.repeat(4000))"\r`,
      },
    );
    await page.waitForFunction((m) => window.__cap.includes(m), marker, { timeout: 20000 });
  };

  // Cycle 1: drive a qualifying run and WAIT for the single attention raise (baseline = 1).
  await driveQualifyingRun('conduit-dedup-1');
  await waitNeedsAttention(sidA);
  const sawFirstFlash = (await getSpyCalls(app)).some(
    (c) => c.api === 'flashFrame' && c.args[0] === true,
  );
  assert(sawFirstFlash, 'Cycle 1 should raise attention once (baseline)');

  // Cycle 2: another FULL qualifying run without the user ever looking at the session.
  // Stronger than the old "any second idle edge": even real new work must not re-fire an
  // episode the user has not acknowledged (spec contract 3).
  await driveQualifyingRun('conduit-dedup-2');
  assert(
    await observeNothingFor(10000, async () => {
      const n = (await getSpyCalls(app)).filter(
        (c) => c.api === 'flashFrame' && c.args[0] === true,
      ).length;
      return n === 1;
    }),
    'second qualifying run must not raise another flashFrame(true) during the quiet window',
  );

  const dedupCalls = await getSpyCalls(app);
  const flashTrueCount = dedupCalls.filter(
    (c) => c.api === 'flashFrame' && c.args[0] === true,
  ).length;
  log('flashFrame(true) count across two qualifying runs:', flashTrueCount);
  assert(
    flashTrueCount === 1,
    `attention must be raised exactly once per episode, got ${flashTrueCount}`,
  );
  log('PASS: notification raised once, not repeated ✓');

  await launched.cleanup();
  log('PASS ✓ T1A attention routing: all assertions passed');
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[attention] FAIL ✗', e.message);
    await finishScenario(1);
  }
  console.error('[attention] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  await finishScenario(2);
}

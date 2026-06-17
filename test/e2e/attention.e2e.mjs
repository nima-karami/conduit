import {
  assert,
  clearSpyCalls,
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
  process.exit(0);
}

// Attention routing hinges on real window focus/blur semantics, so it needs a
// visible, focusable window — opt out of the suite's hidden-window mode (the
// terminal output the test drives never arrives against a hidden window here).
delete process.env.CONDUIT_E2E;

const log = makeLog('attention');

// Poll interval and maximum wait for flashFrame(true) to appear.
// The activity sweep fires every 750ms; the busy window is ~3s of no output
// before the session is marked idle and needsAttention fires.  Under load
// (in-suite, back-to-back Electron launches) the sweep can be delayed, so we
// poll for up to 20s rather than doing a single fixed wait.
const FLASH_POLL_INTERVAL_MS = 300;
const FLASH_POLL_TIMEOUT_MS = 20000;
// How much terminal output to send to simulate "busy" (the sweep detects idle
// when output stops for ~3s after the last write).
const BUSY_PAYLOAD = 'echo conduit-busy-test\r';

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
  // Two sessions: needsAttention only fires when a session goes busy→idle while
  // it is NOT the active session (src/session-activity.ts: id !== focusedId).
  // So sidB is kept active and the busy→idle edge is driven in the BACKGROUND
  // sidA. (A single active session can never raise its own attention.)
  const sidA = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  const sidB = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // Make sidB the active session so sidA is in the background.
  await page.evaluate((id) => window.agentDeck.post({ type: 'focus', id }), sidB);
  // Give the IPC focus message time to arrive and be processed in the main process
  // before we send PTY output on sidA.
  await page.waitForTimeout(500);

  // Wait for initial shell prompt (some output).
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });

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

  log('session is busy — polling for sweep to detect idle and raise attention...');

  // Poll until flashFrame(true) appears in the spy buffer.  The main-process spy
  // is read via app.evaluate, so we poll from outside the page context.
  // This is far more robust than a single fixed-length wait under load.
  let callsAfterBlur = [];
  let flashTrueFound = false;
  const pollDeadline = Date.now() + FLASH_POLL_TIMEOUT_MS;
  while (Date.now() < pollDeadline) {
    callsAfterBlur = await getSpyCalls(app);
    flashTrueFound = callsAfterBlur.some((c) => c.api === 'flashFrame' && c.args[0] === true);
    if (flashTrueFound) break;
    await page.waitForTimeout(FLASH_POLL_INTERVAL_MS);
  }
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

  // The main process has win.on('focus', () => win.flashFrame(false)).
  await page.waitForTimeout(500);

  const callsAfterFocus = await getSpyCalls(app);
  log(
    'spy calls after focus:',
    JSON.stringify(callsAfterFocus.map((c) => ({ api: c.api, args: c.args }))),
  );

  const flashFalse = callsAfterFocus.find((c) => c.api === 'flashFrame' && c.args[0] === false);
  assert(flashFalse, 'Expected flashFrame(false) when window regains focus');
  log('PASS: flashFrame(false) on focus ✓');

  // ── Part 3: focused window + busy→idle should NOT raise attention ───────────
  await clearSpyCalls(app);
  // Window is now focused. Send more output; the sweep fires but shouldRaiseOsAttention
  // returns false because windowFocused = true.
  await page.evaluate(
    ({ s, cmd }) => {
      window.__cap = '';
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: cmd });
    },
    { s: sidA, cmd: 'echo conduit-focused-test\r' },
  );
  await page.waitForFunction(() => window.__cap.includes('conduit-focused-test'), null, {
    timeout: 15000,
  });
  // Wait long enough for the sweep to fire at least once (~3s idle + 750ms sweep).
  // 8s is sufficient; we don't need the full 15s poll here since we're checking
  // that something does NOT happen.
  await page.waitForTimeout(8000);

  const callsWhileFocused = await getSpyCalls(app);
  const flashTrueWhileFocused = callsWhileFocused.find(
    (c) => c.api === 'flashFrame' && c.args[0] === true,
  );
  assert(!flashTrueWhileFocused, 'flashFrame(true) must NOT fire when window is focused');
  log('PASS: no attention raised while window is focused ✓');

  // ── Part 4: a session must notify only ONCE per unacknowledged episode ───────
  // An agent/terminal that emits intermittent output cycles busy→idle repeatedly; each
  // idle used to look like a fresh "finished" edge and re-raise attention (the reported
  // bug: the notification kept firing over and over). It should raise once and stay quiet
  // until the user acknowledges by focusing the session.

  // Reset sidA's notified state: focus it (clears the guard + needsAttention), then put it
  // back in the background. (Part 1 already notified it; window focus is not session focus.)
  await page.evaluate((id) => window.agentDeck.post({ type: 'focus', id }), sidA);
  await page.waitForTimeout(200);
  await page.evaluate((id) => window.agentDeck.post({ type: 'focus', id }), sidB);
  await page.waitForTimeout(300);

  await setWindowFocus(app, false);
  await clearSpyCalls(app);

  const driveBusyIdle = async (marker) => {
    await page.evaluate(
      ({ s, cmd }) => {
        window.__cap = '';
        window.agentDeck.post({ type: 'term:input', sessionId: s, data: cmd });
      },
      { s: sidA, cmd: `echo ${marker}\r` },
    );
    await page.waitForFunction((m) => window.__cap.includes(m), marker, { timeout: 15000 });
  };

  // Cycle 1: drive busy→idle and WAIT for the single attention raise (baseline = 1).
  await driveBusyIdle('conduit-dedup-1');
  let sawFirstFlash = false;
  const dedupDeadline = Date.now() + FLASH_POLL_TIMEOUT_MS;
  while (Date.now() < dedupDeadline) {
    const calls = await getSpyCalls(app);
    if (calls.some((c) => c.api === 'flashFrame' && c.args[0] === true)) {
      sawFirstFlash = true;
      break;
    }
    await page.waitForTimeout(FLASH_POLL_INTERVAL_MS);
  }
  assert(sawFirstFlash, 'Cycle 1 should raise attention once (baseline)');

  // Cycle 2: re-go busy→idle WITHOUT focusing the session — must NOT raise again.
  await driveBusyIdle('conduit-dedup-2');
  await page.waitForTimeout(8000); // let the sweep fire on the second idle edge

  const dedupCalls = await getSpyCalls(app);
  const flashTrueCount = dedupCalls.filter(
    (c) => c.api === 'flashFrame' && c.args[0] === true,
  ).length;
  log('flashFrame(true) count across two busy→idle cycles:', flashTrueCount);
  assert(
    flashTrueCount === 1,
    `attention must be raised exactly once per episode, got ${flashTrueCount}`,
  );
  log('PASS: notification raised once, not repeated ✓');

  await launched.cleanup();
  log('PASS ✓ T1A attention routing: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[attention] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[attention] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

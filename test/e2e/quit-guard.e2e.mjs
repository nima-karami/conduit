/**
 * W2 — Quit / close / update-relaunch guard (smoke)
 *
 * Exercises the main-process `close` event interception and the update-relaunch
 * confirm flow. A running session must trigger a `confirmQuit` message to the
 * renderer before the app closes. Cancelling keeps the window open; proceeding
 * allows the close.
 *
 * Windows only.
 */

import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[quit-guard] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('quit-guard');
const CONFIRM_TIMEOUT_MS = 5000; // max wait for confirmQuit to arrive

let launched = null;
try {
  launched = await launchApp();
  const { app, page } = launched;

  // ── Setup: tap the bridge and capture confirmQuit messages ─────────────────
  await tapBridge(page);

  // Extend the bridge tap to also capture confirmQuit messages.
  await page.evaluate(() => {
    window.__confirmQuitMsgs = [];
    const _origSub = window.agentDeck.subscribe.bind(window.agentDeck);
    // We piggyback on the existing agentDeck.subscribe. The harness tapBridge
    // already wired a subscriber for state/term:data; add another subscriber
    // specifically for confirmQuit so we can capture it independently.
    window.agentDeck.subscribe((m) => {
      if (m.type === 'confirmQuit') {
        window.__confirmQuitMsgs.push(m);
      }
    });
  });

  // ── Open a running session ──────────────────────────────────────────────────
  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  log('running session opened, id =', sid);

  // Verify session is running in the renderer state.
  const isRunning = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'running',
    sid,
  );
  assert(isRunning, 'Expected session to be running before close test');
  log('session status = running ✓');

  // ── Part 1: trigger close with running session — should be preventDefault'd ─

  // Trigger win.close() from the main process.
  await app.evaluate((electron) => {
    const { BrowserWindow } = electron;
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.close();
  });

  log('win.close() triggered — waiting for confirmQuit...');

  // Wait for the confirmQuit message to arrive in the renderer.
  const confirmQuitArrived = await page
    .waitForFunction(() => window.__confirmQuitMsgs && window.__confirmQuitMsgs.length > 0, null, {
      timeout: CONFIRM_TIMEOUT_MS,
    })
    .then(() => true)
    .catch(() => false);

  assert(
    confirmQuitArrived,
    'Expected confirmQuit message from host when closing with running sessions',
  );
  log('confirmQuit arrived in renderer ✓');

  // Verify the window is still open (close was preventDefault'd).
  const windowStillOpen = await app.evaluate((electron) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().length > 0;
  });
  assert(windowStillOpen, 'Window should still be open after confirmQuit (before user replies)');
  log('window still open after confirmQuit ✓');

  // Read the confirmQuit message details.
  const confirmMsg = await page.evaluate(() => window.__confirmQuitMsgs[0]);
  assert(confirmMsg.reason === 'quit', `Expected reason='quit', got '${confirmMsg.reason}'`);
  assert(
    typeof confirmMsg.running === 'number' && confirmMsg.running > 0,
    `Expected running > 0, got ${confirmMsg.running}`,
  );
  log('confirmQuit reason=quit, running=', confirmMsg.running, '✓');

  // ── Part 2: cancel — app stays open ────────────────────────────────────────

  // Clear captured messages for the next check.
  await page.evaluate(() => {
    window.__confirmQuitMsgs = [];
  });

  // Send cancel decision.
  await page.evaluate(() => {
    window.agentDeck.post({ type: 'quitDecision', proceed: false });
  });

  // Give the main process a moment to process the cancel.
  await page.waitForTimeout(500);

  const windowOpenAfterCancel = await app.evaluate((electron) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().length > 0;
  });
  assert(windowOpenAfterCancel, 'Window should remain open after cancel quitDecision');
  log('window still open after cancel ✓');

  // ── Part 3: proceed — app quits ────────────────────────────────────────────

  // Trigger close again.
  await app.evaluate((electron) => {
    const { BrowserWindow } = electron;
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.close();
  });

  // Wait for confirmQuit again.
  const confirmQuitArrived2 = await page
    .waitForFunction(() => window.__confirmQuitMsgs && window.__confirmQuitMsgs.length > 0, null, {
      timeout: CONFIRM_TIMEOUT_MS,
    })
    .then(() => true)
    .catch(() => false);
  assert(confirmQuitArrived2, 'Expected confirmQuit on second close attempt');
  log('confirmQuit arrived again ✓');

  // Send proceed decision — the app should quit.
  await page.evaluate(() => {
    window.agentDeck.post({ type: 'quitDecision', proceed: true });
  });

  // Wait for the app to actually close (window gone).
  // Use a plain setTimeout (not page.waitForTimeout) because the page closes
  // when the app quits — calling page.waitForTimeout after close throws.
  let closedAfterProceed = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const windowCount = await app
      .evaluate((electron) => {
        const { BrowserWindow } = electron;
        return BrowserWindow.getAllWindows().length;
      })
      .catch(() => 0);
    if (windowCount === 0) {
      closedAfterProceed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(closedAfterProceed, 'App should have closed after proceed quitDecision');
  log('app closed after proceed ✓');

  // ── Part 4: updateRelaunch with running session — update-flavored confirm ──
  // Re-launch the app for this part.
  try {
    await launched.cleanup();
  } catch {
    /* already closed */
  }

  launched = await launchApp();
  const { app: app2, page: page2 } = launched;
  await tapBridge(page2);

  await page2.evaluate(() => {
    window.__confirmQuitMsgs = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'confirmQuit') window.__confirmQuitMsgs.push(m);
    });
  });

  const sid2 = await openSession(page2, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  log('second session opened, id =', sid2);

  // Send updateRelaunch — since app.isPackaged=false, quitAndInstall is a no-op,
  // but needsQuitConfirm fires first and routes to confirmWithRenderer.
  await page2.evaluate(() => {
    window.agentDeck.post({ type: 'updateRelaunch' });
  });

  // Wait for confirmQuit with reason='update'.
  const updateConfirmArrived = await page2
    .waitForFunction(() => window.__confirmQuitMsgs && window.__confirmQuitMsgs.length > 0, null, {
      timeout: CONFIRM_TIMEOUT_MS,
    })
    .then(() => true)
    .catch(() => false);

  assert(
    updateConfirmArrived,
    'Expected confirmQuit with reason=update when updateRelaunch fired with running sessions',
  );
  const updateConfirmMsg = await page2.evaluate(() => window.__confirmQuitMsgs[0]);
  assert(
    updateConfirmMsg.reason === 'update',
    `Expected reason='update', got '${updateConfirmMsg.reason}'`,
  );
  log('update confirmQuit arrived with reason=update ✓');

  // Cancel — app stays open, update pending.
  await page2.evaluate(() => {
    window.agentDeck.post({ type: 'quitDecision', proceed: false });
  });
  await page2.waitForTimeout(300);

  const windowOpenAfterUpdateCancel = await app2.evaluate((electron) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().length > 0;
  });
  assert(windowOpenAfterUpdateCancel, 'Window should remain open after cancelling update relaunch');
  log('app stayed open after update cancel ✓');

  // ── Part 5: no prompt when no running sessions ──────────────────────────────
  // The app auto-opens a session from the REPO launch arg on top of the ones this
  // test opened, so kill every running session — not just sid2 — to reach zero.
  await page2.evaluate(() => {
    for (const s of window.__sessions || []) {
      if (s.status === 'running') window.agentDeck.post({ type: 'kill', id: s.id });
    }
  });

  await page2.waitForFunction(
    () => !(window.__sessions || []).some((s) => s.status === 'running'),
    null,
    { timeout: 10000 },
  );
  log('all sessions killed / none running ✓');

  // Clear captured messages.
  await page2.evaluate(() => {
    window.__confirmQuitMsgs = [];
  });

  // Trigger close — should NOT fire confirmQuit.
  await app2.evaluate((electron) => {
    const { BrowserWindow } = electron;
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.close();
  });

  // Wait briefly to ensure no confirmQuit arrives before the app closes.
  // We poll for up to 2s: either the window closes (no guard) or confirmQuit fires.
  let appClosedWithNoPrompt = false;
  let unexpectedConfirmQuit = false;
  const noPromptDeadline = Date.now() + 3000;
  while (Date.now() < noPromptDeadline) {
    const [windowCount, _confirmCount] = await app2
      .evaluate((electron) => {
        const { BrowserWindow } = electron;
        return [BrowserWindow.getAllWindows().length, 0];
      })
      .catch(() => [0, 0]);
    const confirmCount2 = await page2
      .evaluate(() => (window.__confirmQuitMsgs || []).length)
      .catch(() => 0);
    if (confirmCount2 > 0) {
      unexpectedConfirmQuit = true;
      break;
    }
    if (windowCount === 0) {
      appClosedWithNoPrompt = true;
      break;
    }
    // Use plain setTimeout (not page2.waitForTimeout) — the page may close
    // mid-loop if the app quits without a guard prompt.
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(!unexpectedConfirmQuit, 'confirmQuit must NOT fire when no running sessions on close');
  assert(appClosedWithNoPrompt, 'App should close without prompt when no running sessions');
  log('no prompt with no running sessions, app closed cleanly ✓');

  log('PASS ✓ W2 quit-guard: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[quit-guard] FAIL ✗', e.message);
  } else {
    console.error('[quit-guard] ERROR:', e?.message || e);
  }
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}

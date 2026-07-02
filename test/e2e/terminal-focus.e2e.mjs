/**
 * Switching the active session must focus that session's terminal input, so the user can
 * type immediately without clicking into it. Regression guard for round-3 #2: previously the
 * terminal was focused only once (on first PTY start); a sidebar switch left focus on nothing
 * (the clicked row is a non-focusable div), so keystrokes went nowhere until you clicked the
 * terminal. The fix is an app.tsx effect keyed on the active session id that re-focuses the
 * newly-visible terminal via the focus bus.
 *
 * Real DOM focus (`document.activeElement`) needs a visible, focusable window, so this opts out
 * of the suite's hidden-window mode (same as attention.e2e.mjs).
 */
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession, REPO } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[terminal-focus] SKIP — suite is Windows-only');
  process.exit(0);
}

delete process.env.CONDUIT_E2E;

const log = makeLog('terminal-focus');

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  // Opt into the terminal observability hook BEFORE any terminal mounts, so the typed-key
  // assertion can read the rendered buffer (terminal-pane registers into a pre-existing map).
  await page.evaluate(() => {
    window.__terms = {};
  });

  // Two sessions at distinct paths so their sidebar rows have distinct names to click.
  const a = await openSession(page, { path: REPO });
  const b = await openSession(page, { path: join(REPO, 'webview') });
  log(`sessions: A=${a} (conduit) · B=${b} (webview)`);

  const switchTo = async (name) => {
    await page
      .locator('.session', { has: page.locator('.session__name', { hasText: name }) })
      .first()
      .click();
  };

  // The fix focuses inside a requestAnimationFrame after the session switch commits, so poll
  // until the focused element is the visible terminal's xterm textarea (only the active
  // session's terminal is display:flex; the rest are display:none → offsetParent null).
  const assertTerminalFocused = async (label) => {
    const ok = await page
      .waitForFunction(
        () => {
          const el = document.activeElement;
          return !!el && el.classList.contains('xterm-helper-textarea') && el.offsetParent !== null;
        },
        null,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    assert(ok, `expected the ${label} terminal textarea focused after switching to it`);
    log(`PASS: switching to ${label} focused its terminal input ✓`);
  };

  // Switch away to A, then back to B — each switch must land focus in that session's terminal.
  await switchTo('conduit');
  await assertTerminalFocused('A (conduit)');

  await switchTo('webview');
  await assertTerminalFocused('B (webview)');

  // Prove it end-to-end: with B focused, a typed key reaches B's shell (not A's).
  await page.keyboard.type('echo focus-ok');
  const landed = await page
    .waitForFunction(
      (id) => {
        const t = window.__terms?.[id];
        if (!t) return false;
        const buf = t.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          if (buf.getLine(i)?.translateToString(true).includes('focus-ok')) return true;
        }
        return false;
      },
      b,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(landed, "typed keys should reach session B's terminal after the switch");
  log('PASS: typed text landed in the active session terminal ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[terminal-focus] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}

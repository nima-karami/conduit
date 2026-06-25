/**
 * exit-closes-session (smoke)
 *
 * Typing `exit` in a plain shell ends the PTY; the host marks the session `exited`
 * and the renderer auto-closes it (a plain shell with no open editor tabs). Drives the
 * REAL app + ConPTY: opens a shell, sends `exit\r\n`, asserts the session disappears
 * from renderer state (was running, now gone).
 *
 * Windows only.
 */

import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[exit-closes-session] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('exit-closes-session');

let launched = null;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);

  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  log('shell session opened, id =', sid);

  // It must register as running first so the renderer records the running→exited edge.
  await page.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'running',
    sid,
    { timeout: 15000 },
  );
  log('session running ✓');

  // Let cmd.exe reach its prompt before sending input (as a real user would) — input
  // sent during ConPTY startup is dropped and the shell never exits.
  await page.waitForTimeout(2000);

  // Send `exit` to the shell's PTY — cmd.exe terminates.
  await page.evaluate(
    (id) => window.agentDeck.post({ type: 'term:input', sessionId: id, data: 'exit\r\n' }),
    sid,
  );
  log('sent exit to PTY');

  // The renderer should auto-close the session (plain shell, no open editors): gone
  // from state entirely (not lingering as an "exited" Restart card).
  const closed = await page
    .waitForFunction((id) => !(window.__sessions || []).some((s) => s.id === id), sid, {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false);

  assert(closed, 'Plain shell should auto-close after the PTY exits (no open editors)');
  log('session auto-closed after exit ✓');

  log('PASS ✓ exit-closes-session: plain shell auto-closes on PTY exit');
  // Bound the teardown — app.close() can hang on a loaded machine; the assertion already
  // passed, so don't let a slow close turn a PASS into a TIMEOUT.
  await Promise.race([launched.cleanup(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.log(`[exit-closes-session] ${isAssertion ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}

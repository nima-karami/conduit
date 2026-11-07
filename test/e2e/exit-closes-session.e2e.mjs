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

import {
  assert,
  finishScenario,
  launchApp,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[exit-closes-session] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('exit-closes-session');

let launched = null;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  await page.evaluate(() => {
    window.__terms = {};
  });

  const sid = await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  log('shell session opened, id =', sid);

  // It must register as running first so the renderer records the running→exited edge.
  await page.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'running',
    sid,
    { timeout: 15000 },
  );
  log('session running ✓');

  await page.waitForFunction((id) => /Microsoft Windows/.test(window.__capBy?.[id] ?? ''), sid, {
    timeout: 20_000,
  });
  const marker = `CONDUIT-EXIT-READY-${sid}`;
  await page.evaluate(
    ({ id, text }) =>
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: `echo ${text}\r\n` }),
    { id: sid, text: marker },
  );
  await page.waitForFunction(
    ({ id, text }) => {
      const buffer = window.__terms?.[id]?.buffer?.active;
      if (!buffer) return false;
      for (let y = 0; y < buffer.length; y++)
        if (buffer.getLine(y)?.translateToString(true).trim() === text) return true;
      return false;
    },
    { id: sid, text: marker },
    { timeout: 20_000 },
  );

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
  // cleanup uses the harness's bounded shutdown grace period.
  await launched.cleanup();
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.log(`[exit-closes-session] ${isAssertion ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  await finishScenario(isAssertion ? 1 : 2);
}

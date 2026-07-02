/**
 * Session data-loss guard — toggling "reopen previous sessions" OFF must NOT wipe the
 * persisted session list (feat-session-dataloss).
 *
 * 1. Launch with a throwaway user-data dir, open a session, quit → sessions.json holds it.
 * 2. Re-launch on the SAME dir, turn restoreSessions OFF via updateSettings, then quit.
 *    Before the fix, the restore-off quit (and the onChange during PTY teardown) wrote
 *    serializeSessions([]) over sessions.json, destroying the saved set.
 * 3. Assert sessions.json STILL contains the original session after the restore-off quit.
 * 4. Re-launch with restoreSessions back ON → the session restores (nothing was lost).
 *
 * Windows only.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, loadPlaywright, makeLog, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[session-restore-toggle] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('session-restore-toggle');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-restore-toggle-'));
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
  return { app, page };
}

// Capture the latest state.settings so we can round-trip a modified copy back via updateSettings.
async function tapSettings(page) {
  await page.evaluate(() => {
    window.__settings = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') window.__settings = m.settings || null;
    });
    window.agentDeck.post({ type: 'ready' });
  });
}

const sessionsPath = join(userDataDir, 'sessions.json');

let appHandle;
try {
  // ── Launch 1: open a session, quit with restore ON (default) ─────────────────
  const first = await launch();
  appHandle = first.app;
  const { page: page1 } = first;
  await tapBridge(page1);

  await page1.evaluate(
    (repo) => window.agentDeck.post({ type: 'openRepo', path: repo, agentId: 'shell:cmd' }),
    REPO.replace(/\\/g, '/'),
  );
  await page1.waitForSelector('.termpane', { state: 'attached', timeout: 25000 });

  const sid = await page1
    .waitForFunction(
      () => (window.__sessions || []).find((s) => s.status === 'running')?.id || null,
      null,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
  assert(sid, 'No running session found after openRepo');
  log('first launch: session running, id =', sid);

  await page1.waitForTimeout(500);
  assert(existsSync(sessionsPath), 'sessions.json was not written');
  await closeApp(appHandle, page1);
  appHandle = null;

  const savedAfterFirst = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  assert(
    (savedAfterFirst.sessions || []).some((s) => s.id === sid),
    `Session ${sid} not persisted after first quit`,
  );
  log('session persisted with restore ON ✓');

  // ── Launch 2: turn restore OFF, then quit ────────────────────────────────────
  const second = await launch();
  appHandle = second.app;
  const { page: page2 } = second;
  await tapBridge(page2);
  await tapSettings(page2);

  const current = await page2
    .waitForFunction(() => window.__settings || null, null, { timeout: 20000 })
    .then((h) => h.jsonValue());
  assert(current, 'Never received settings from state');
  assert(current.restoreSessions === true, 'Expected restore ON on second launch');

  await page2.evaluate(
    (s) => window.agentDeck.post({ type: 'updateSettings', settings: { ...s, restoreSessions: false } }),
    current,
  );
  await page2.waitForFunction(() => window.__settings && window.__settings.restoreSessions === false, null, {
    timeout: 20000,
  });
  log('restore turned OFF ✓');

  await closeApp(appHandle, page2);
  appHandle = null;

  // The data-loss assertion: the saved session must SURVIVE a restore-off quit.
  const savedAfterOff = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  assert(
    (savedAfterOff.sessions || []).some((s) => s.id === sid),
    `DATA LOSS: session ${sid} wiped from sessions.json after turning restore OFF`,
  );
  log('PASS: session survived restore-off quit ✓');

  // ── Launch 3: restore back ON → the session comes back ───────────────────────
  const third = await launch();
  appHandle = third.app;
  const { page: page3 } = third;
  await tapBridge(page3);
  await tapSettings(page3);

  const s3 = await page3
    .waitForFunction(() => window.__settings || null, null, { timeout: 20000 })
    .then((h) => h.jsonValue());
  await page3.evaluate(
    (s) => window.agentDeck.post({ type: 'updateSettings', settings: { ...s, restoreSessions: true } }),
    s3,
  );
  await closeApp(appHandle, page3);
  appHandle = null;

  // Final relaunch verifies restore now rehydrates the preserved session as stale.
  const fourth = await launch();
  appHandle = fourth.app;
  const { page: page4 } = fourth;
  await tapBridge(page4);

  const restored = await page4
    .waitForFunction((id) => (window.__sessions || []).find((s) => s.id === id) || null, sid, {
      timeout: 45000,
    })
    .then((h) => h.jsonValue());
  assert(restored, `Session ${sid} not restored after re-enabling restore`);
  assert(restored.status === 'stale', `Expected 'stale', got '${restored.status}'`);
  log('PASS: re-enabling restore brings the session back ✓');

  await closeApp(appHandle, page4);
  appHandle = null;

  log('PASS ✓ session-restore-toggle: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[session-restore-toggle] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[session-restore-toggle] ERROR:', e?.message || e);
  try {
    if (appHandle) await appHandle.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

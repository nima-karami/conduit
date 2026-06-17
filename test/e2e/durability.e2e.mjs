/**
 * T1B — Session durability / restore (FULL)
 *
 * 1. Launch the app with a throwaway user-data dir, open a session.
 * 2. Close the app (simulating a restart) — sessions persist to sessions.json.
 * 3. Re-launch the same app on the SAME user-data dir.
 * 4. Assert the session is restored (status = 'stale').
 * 5. Send a 'relaunch' message and assert it returns to 'running'.
 *
 * Windows only.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, loadPlaywright, makeLog, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[durability] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('durability');

// Use a SHARED user-data dir across both launches so sessions persist.
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-dur-'));
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

let firstApp;
let secondApp;
try {
  // ── Launch 1: open a session ─────────────────────────────────────────────────
  const first = await launch();
  firstApp = first.app;
  const { page: page1 } = first;

  await tapBridge(page1);

  // Open a session.
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

  // Wait a moment to ensure sessions.json is written (mgr.onChange triggers write).
  await page1.waitForTimeout(500);
  const sessionsPath = join(userDataDir, 'sessions.json');
  assert(existsSync(sessionsPath), 'sessions.json was not written to userData dir');
  log('sessions.json exists ✓');

  // Close the first app (simulates user closing Conduit).
  await firstApp.close();
  firstApp = null;
  log('first app closed ✓');

  // Verify sessions.json contains the session.
  const raw = readFileSync(sessionsPath, 'utf8');
  const saved = JSON.parse(raw);
  const savedSession = (saved.sessions || []).find((s) => s.id === sid);
  assert(savedSession, `Session ${sid} not found in sessions.json`);
  log('session persisted to sessions.json ✓');

  // ── Launch 2: sessions restore as stale ──────────────────────────────────────
  const second = await launch();
  secondApp = second.app;
  const { page: page2 } = second;

  await tapBridge(page2);

  // The app restores sessions from sessions.json on startup. Wait for state to arrive.
  // Under load (in-suite), the second launch can be slow — give it 45s headroom.
  const restoredSession = await page2
    .waitForFunction((id) => (window.__sessions || []).find((s) => s.id === id) || null, sid, {
      timeout: 45000,
    })
    .then((h) => h.jsonValue());

  assert(restoredSession, `Session ${sid} not found in restored state`);
  assert(
    restoredSession.status === 'stale',
    `Expected status 'stale' after restore, got '${restoredSession.status}'`,
  );
  log('PASS: session restored as stale ✓', restoredSession.status);

  // ── Relaunch: send 'relaunch' → session returns to running ──────────────────
  await page2.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);

  // Wait for status to become 'running'.  Under load (in-suite back-to-back
  // launches) ConPTY startup can be slow — give it 45s headroom.
  const relaunched = await page2
    .waitForFunction(
      (id) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return s && s.status === 'running' ? s : null;
      },
      sid,
      { timeout: 45000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);

  assert(relaunched, `Session did not return to 'running' after relaunch (within 45s)`);
  assert(
    relaunched.status === 'running',
    `Expected 'running' after relaunch, got '${relaunched.status}'`,
  );
  log('PASS: session relaunched to running ✓');

  await secondApp.close();
  secondApp = null;

  log('PASS ✓ T1B durability: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[durability] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[durability] ERROR:', e?.message || e);
  try {
    if (firstApp) await firstApp.close();
  } catch {
    /* ignore */
  }
  try {
    if (secondApp) await secondApp.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

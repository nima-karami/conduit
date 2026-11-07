/**
 * T1B — Session durability / restore (FULL)
 *
 * 1. Launch the app with a throwaway user-data dir, open a session.
 * 2. Close the app (simulating a restart) — sessions persist to sessions.json.
 * 3. Re-launch on the SAME user-data dir: the agent kept running in hc (F4), so the session
 *    re-attaches live (status = 'running').
 * 4. Close again and stop the server and its agents (a reboot), then re-launch: the session is
 *    restored cold (status = 'stale').
 * 5. Send a 'relaunch' message and assert it returns to 'running'.
 *
 * Windows only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  finishScenario,
  launchElectron,
  makeLog,
  profileDir,
  REPO,
  stopServer,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[durability] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('durability');

// Use a SHARED user-data dir across both launches so sessions persist.
const userDataDir = profileDir('dur');
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  return { app, page };
}

try {
  // ── Launch 1: open a session ─────────────────────────────────────────────────
  const first = await launch();
  const { app: firstApp, page: page1 } = first;

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

  const sessionsPath = join(userDataDir, 'sessions.json');
  await page1.exposeFunction('__sessionsFileExists', () => existsSync(sessionsPath));
  await page1.waitForFunction(() => window.__sessionsFileExists(), null, { timeout: 5000 });
  await page1.removeExposedFunction('__sessionsFileExists');
  assert(existsSync(sessionsPath), 'sessions.json was not written to userData dir');
  log('sessions.json exists ✓');

  // Close the first app (simulates user closing Conduit). The session is running, so the
  // quit-guard asks for confirmation — closeApp answers it (proceed) and waits for exit. This
  // also exercises before-quit's synchronous state flush (the update-durability fix).
  await closeApp(firstApp, page1);
  log('first app closed ✓');

  // Verify sessions.json contains the session.
  const raw = readFileSync(sessionsPath, 'utf8');
  const saved = JSON.parse(raw);
  const savedSession = (saved.sessions || []).find((s) => s.id === sid);
  assert(savedSession, `Session ${sid} not found in sessions.json`);
  log('session persisted to sessions.json ✓');

  // ── Launch 2: the agent outlived the app, so the session re-attaches live ────
  const live = await launch();
  await tapBridge(live.page);
  const reattached = await live.page
    .waitForFunction((id) => (window.__sessions || []).find((s) => s.id === id) || null, sid, {
      timeout: 45000,
    })
    .then((h) => h.jsonValue());
  assert(
    reattached.status === 'running',
    `Expected the live session to re-attach as 'running', got '${reattached.status}'`,
  );
  log('PASS: session re-attached live after a quit ✓');
  await closeApp(live.app, live.page);
  await stopServer(live.app);
  log('server and agents stopped (cold restart) ✓');

  // ── Launch 3: with the agent gone, the session restores as stale ────────────
  const second = await launch();
  const { app: secondApp, page: page2 } = second;

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

  await closeApp(secondApp, page2);

  log('PASS ✓ T1B durability: all assertions passed');
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[durability] FAIL ✗', e.message);
    await finishScenario(1);
  }
  // No bare close here: with a running session it waits on the quit guard forever;
  // finishScenario ends any app still open.
  console.error('[durability] ERROR:', e?.message || e);
  await finishScenario(2);
}

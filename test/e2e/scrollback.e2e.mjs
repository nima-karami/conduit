/**
 * Scrollback persistence (QUARANTINED — authored but skipped today)
 *
 * This scenario is INTENTIONALLY guarded to SKIP until the scrollback-persistence
 * feature is implemented. The assertion is written so it flips from SKIP to PASS
 * (or FAIL) once the feature lands.
 *
 * Feature contract (when implemented):
 *   After restarting the app on the same user-data dir, the prior term:data output
 *   for a session is present in the restored session's terminal (scrollback history
 *   is persisted). The assertion checks that a known sentinel written before the
 *   restart appears in the captured term:data after restore.
 *
 * Feature-presence check: look for the 'scrollbackPersistence' key in AppSettings
 * (it would be added when the feature ships, e.g. as settings.scrollbackPersistence).
 * Until that key exists, this file exits SKIP.
 */

import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, loadPlaywright, makeLog, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[scrollback] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('scrollback');

// ── Feature-presence gate ───────────────────────────────────────────────────
// Check whether scrollback persistence has landed by inspecting the settings
// object in the state message. The feature would expose a key such as
// 'scrollbackPersistence' (boolean) or 'scrollbackLines' (number). If neither
// is present in the state, this test SKIPs rather than failing.
async function checkFeaturePresent(page) {
  const hasFeature = await page.evaluate(() => {
    return new Promise((resolve) => {
      const unsub = window.agentDeck.subscribe((m) => {
        if (m.type === 'state') {
          unsub();
          const s = m.settings || {};
          // Check for anticipated feature keys.
          resolve(
            'scrollbackPersistence' in s || 'scrollbackLines' in s || 'persistScrollback' in s,
          );
        }
      });
      window.agentDeck.post({ type: 'ready' });
      // Timeout: if no state within 5s, feature is absent.
      setTimeout(() => {
        unsub();
        resolve(false);
      }, 5000);
    });
  });
  return hasFeature;
}

const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-sb-'));

let firstApp;
let secondApp;
try {
  // ── Launch 1: feature-presence check ────────────────────────────────────────
  firstApp = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page1 = await firstApp.firstWindow();
  await page1.waitForLoadState('domcontentloaded');
  await page1.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });

  const featurePresent = await checkFeaturePresent(page1);
  if (!featurePresent) {
    log('SKIP — scrollback persistence feature not yet present (key absent from settings)');
    await firstApp.close();
    process.exit(0);
  }

  // ── Feature is present: run the real assertion ───────────────────────────────

  await tapBridge(page1);

  const SENTINEL = `conduit-scrollback-sentinel-${Date.now()}`;

  // Open a session and write the sentinel to the terminal.
  await page1.evaluate(
    (repo) => window.agentDeck.post({ type: 'openRepo', path: repo, agentId: 'shell:cmd' }),
    REPO.replace(/\\/g, '/'),
  );
  await page1.waitForSelector('.termpane', { timeout: 25000 });
  const sid = await page1
    .waitForFunction(
      () => (window.__sessions || []).find((s) => s.status === 'running')?.id || null,
      null,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
  assert(sid, 'No running session after openRepo');

  // Send a distinctive echo to create scrollback content.
  await page1.evaluate(
    ({ s, sentinel }) => {
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: `echo ${sentinel}\r` });
    },
    { s: sid, sentinel: SENTINEL },
  );
  await page1.waitForFunction((s) => window.__cap.includes(s), SENTINEL, { timeout: 10000 });
  log('sentinel written to terminal ✓');

  // Wait for persistence (implementation would write scrollback to userData).
  await page1.waitForTimeout(1000);
  await firstApp.close();
  firstApp = null;

  // ── Launch 2: assert scrollback survives restart ─────────────────────────────
  secondApp = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page2 = await secondApp.firstWindow();
  await page2.waitForLoadState('domcontentloaded');
  await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page2);

  // Wait for the restored session.
  await page2.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id) || null,
    sid,
    { timeout: 20000 },
  );

  // The feature should replay the persisted scrollback into the terminal.
  // The sentinel should appear in the captured term:data.
  const sentinelRestored = await page2
    .waitForFunction((s) => window.__cap.includes(s), SENTINEL, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  assert(sentinelRestored, `Scrollback sentinel "${SENTINEL}" not found after restart`);
  log('PASS: scrollback persisted across restart ✓');

  await secondApp.close();
  secondApp = null;

  log('PASS ✓ scrollback persistence: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[scrollback] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[scrollback] ERROR:', e?.message || e);
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

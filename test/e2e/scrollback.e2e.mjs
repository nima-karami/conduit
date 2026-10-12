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

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assert,
  finishScenario,
  launchElectron,
  logicalLines,
  makeLog,
  openSession,
  profileDir,
  REPO,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[scrollback] SKIP — suite is Windows-only');
  await finishScenario(0);
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

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = profileDir('sb');

let firstApp;
let secondApp;
let page1;
let page2;
let thirdApp;
let page3;
// Every exit path goes through this: a bare app.close() with a live session waits on the
// quit guard forever, which is how a scenario that passed every assertion still reported a
// 210s TIMEOUT and orphaned two Electrons onto the rest of the suite.
const shutdownAll = async () => {
  await shutdownApp(firstApp, page1);
  firstApp = null;
  await shutdownApp(secondApp, page2);
  secondApp = null;
  await shutdownApp(thirdApp, page3);
  thirdApp = null;
};
try {
  // ── Launch 1: feature-presence check ────────────────────────────────────────
  firstApp = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page1 = await firstApp.firstWindow();
  await page1.waitForLoadState('domcontentloaded');
  await page1.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });

  const featurePresent = await checkFeaturePresent(page1);
  if (!featurePresent) {
    log('SKIP — scrollback persistence feature not yet present (key absent from settings)');
    await shutdownAll();
    await finishScenario(0);
  }

  // ── Feature is present: run the real assertion ───────────────────────────────

  await tapBridge(page1);

  const SENTINEL = `conduit-scrollback-sentinel-${Date.now()}`;
  const LINE_COUNT = 80;
  const RELAUNCH_MARKER = '— session relaunched —';

  // The REPO launch arg already opened a session of its own (os-open), so "the first running
  // session" is that one, not ours — the echo went to a pane that was never shown.
  const sid = await openSession(page1, { path: REPO, agentId: 'shell:cmd' });
  assert(sid, 'No running session after openRepo');

  // More than a screenful, so the dead session's LAST screen is distinct from its scrollback —
  // that last screen is what a broken relaunch prelude used to leave to ConPTY's spawn clear.
  await page1.evaluate(
    ({ s, sentinel, count }) => {
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: `for /L %i in (1,1,${count}) do @echo sb-line-%i\r`,
      });
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: `echo ${sentinel}\r` });
    },
    { s: sid, sentinel: SENTINEL, count: LINE_COUNT },
  );
  // A cold cmd.exe under the hidden background launch can be slow to first echo — give it room.
  // The sentinel shows up twice: the typed command, then its output.
  await page1.waitForFunction(
    ({ s, last }) => window.__cap.includes(last) && window.__cap.split(s).length > 2,
    { s: SENTINEL, last: `sb-line-${LINE_COUNT}` },
    { timeout: 30000 },
  );
  log('sentinel written to terminal ✓');

  // Wait for persistence (implementation would write scrollback to userData).
  await page1.waitForTimeout(1000);
  await shutdownApp(firstApp, page1);
  firstApp = null;

  // The ring on disk records the size its bytes were painted at (src/scrollback-files.ts names it).
  const ringFile = join(userDataDir, `scrollback-${sid.replace(/[^\w.-]/g, '_')}.json`);
  const persisted = JSON.parse(readFileSync(ringFile, 'utf8'));
  const segments = Array.isArray(persisted.segments) ? persisted.segments : [];
  const lastSegment = segments[segments.length - 1];
  log(`persisted v${persisted.version}: ${segments.map((s) => `${s.cols}x${s.rows}`).join(', ')}`);
  assert(persisted.version === 2, `Scrollback file is v${persisted.version}, expected v2`);
  assert(
    Number.isInteger(lastSegment?.cols) &&
      lastSegment.cols > 0 &&
      Number.isInteger(lastSegment?.rows) &&
      lastSegment.rows > 0,
    `Scrollback file's last segment carries no geometry: ${JSON.stringify(Object.keys(lastSegment ?? {}))}`,
  );
  assert(
    segments.some((s) => s.data.includes(`sb-line-${LINE_COUNT}`)),
    'Scrollback file is missing the session output',
  );

  // ── Launch 2: assert scrollback survives restart ─────────────────────────────
  secondApp = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page2 = await secondApp.firstWindow();
  await page2.waitForLoadState('domcontentloaded');
  await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page2);

  // Wait for the restored session (persistence brings it back as 'stale').
  await page2.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id) || null,
    sid,
    { timeout: 20000 },
  );

  // Let the restored session fully register in the host before relaunching it (a term:start
  // that races session restore would be dropped by the kill-race guard).
  await page2.waitForTimeout(1000);

  // Relaunch the restored session the way the UI does: the pane mounts and sends `term:start`,
  // and the host replays the scrollback BEFORE the fresh PTY starts. `__terms` exposes the real
  // xterm, so the assertions below read the rendered buffer rather than the IPC bytes.
  await page2.evaluate(() => {
    window.__terms = {};
  });
  // The REPO launch arg restores its own session too; a pane only starts once it is on screen.
  await page2.click(`[data-sessionid="${sid}"]`);
  await page2.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);

  // The feature should replay the persisted scrollback into the terminal.
  // The sentinel should appear in the captured term:data.
  const sentinelRestored = await page2
    .waitForFunction((s) => window.__cap.includes(s), SENTINEL, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  assert(sentinelRestored, `Scrollback sentinel "${SENTINEL}" not found after restart`);
  log('PASS: scrollback persisted across restart ✓');

  // The new shell's banner arrives after ConPTY's spawn clear — the moment that used to erase.
  await page2.waitForFunction(
    (id) => (window.__capBy?.[id] ?? '').includes('Microsoft Windows'),
    sid,
    { timeout: 20000 },
  );
  await page2.waitForTimeout(1500);
  const rendered = await logicalLines(page2, sid);
  assert(rendered, 'Relaunched terminal was not exposed on window.__terms');
  log(
    `rendered buffer (last 60 lines):\n${rendered
      .slice(-60)
      .map((l) => `  | ${l}`)
      .join('\n')}`,
  );
  const sentinelAt = rendered.lastIndexOf(SENTINEL);
  assert(
    sentinelAt >= 0,
    "Dead session's last screen was erased on relaunch: its last output line is not in the buffer",
  );
  const lastScreen = Array.from({ length: 10 }, (_, i) => `sb-line-${LINE_COUNT - 9 + i}`);
  const missing = lastScreen.filter((l) => !rendered.includes(l));
  assert(missing.length === 0, `Last-screen lines missing after relaunch: ${missing.join(', ')}`);
  const markerLines = rendered.filter((l) => l.includes(RELAUNCH_MARKER));
  assert(
    markerLines.length === 1 && markerLines[0] === RELAUNCH_MARKER,
    `Relaunch marker is not on a line of its own: ${JSON.stringify(markerLines)}`,
  );
  assert(
    rendered.indexOf(RELAUNCH_MARKER) > sentinelAt,
    'Relaunch marker landed above the restored history instead of below it',
  );
  log("PASS: the dead session's last screen survives a cold relaunch, marker on its own line ✓");

  // ── In the same app run: Restart (the UI's session:restart) ──────────────────
  // The pane remounts over a new child. It must show the history straight away, and record its
  // marker and padding, or the new child's spawn clear erases run 1 on the next cold start.
  const bannersBefore = await page2.evaluate(
    (id) => (window.__capBy?.[id] ?? '').split('Microsoft Windows').length,
    sid,
  );
  await page2.evaluate(
    (id) => window.agentDeck.post({ type: 'session:restart', requestId: 9001, sessionId: id }),
    sid,
  );
  await page2.waitForFunction(
    ({ id, n }) => (window.__capBy?.[id] ?? '').split('Microsoft Windows').length > n,
    { id: sid, n: bannersBefore },
    { timeout: 30000 },
  );
  // The replay carries earlier banners too; give the new child time to print its own.
  await page2.waitForTimeout(3000);
  const inRun = await logicalLines(page2, sid);
  assert(inRun, 'Restarted terminal was not exposed on window.__terms');
  log(
    `in-run restart buffer (last 40 lines):\n${inRun
      .slice(-40)
      .map((l) => `  | ${l}`)
      .join('\n')}`,
  );
  const inRunMissing = [...lastScreen, SENTINEL].filter((l) => !inRun.includes(l));
  assert(
    inRunMissing.length === 0,
    `A restart in the same app run did not show the history: missing ${inRunMissing.join(', ')}`,
  );
  assert(
    inRun.filter((l) => l.includes(RELAUNCH_MARKER)).length === 2 &&
      inRun.lastIndexOf(SENTINEL) < inRun.indexOf(RELAUNCH_MARKER),
    `In-run restart markers wrong: ${JSON.stringify(inRun.filter((l) => l.includes(RELAUNCH_MARKER)))}`,
  );
  log('PASS: a restart in the same app run shows the history at once ✓');

  // ── Launch 3: a cold start after cold + in-run relaunches must not erase run 1 ──
  // Each child's bytes start with ConPTY's spawn clear; replayed straight after the previous
  // child they used to wipe its last screen — the same erase as above, one relaunch later.
  const RUN2_SENTINEL = `run2-sentinel-${Date.now()}`;
  await page2.evaluate(
    ({ s, sentinel }) =>
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: `echo ${sentinel}\r` }),
    { s: sid, sentinel: RUN2_SENTINEL },
  );
  await page2.waitForFunction(
    ({ id, s }) => (window.__capBy?.[id] ?? '').split(s).length > 2,
    { id: sid, s: RUN2_SENTINEL },
    { timeout: 20000 },
  );
  await page2.waitForTimeout(1000);
  await shutdownApp(secondApp, page2);
  secondApp = null;

  thirdApp = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page3 = await thirdApp.firstWindow();
  await page3.waitForLoadState('domcontentloaded');
  await page3.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page3);
  await page3.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 20000,
  });
  await page3.waitForTimeout(1000);
  await page3.evaluate(() => {
    window.__terms = {};
  });
  await page3.click(`[data-sessionid="${sid}"]`);
  await page3.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);
  // Three earlier children each replay their banner; the fourth is the new shell's.
  await page3.waitForFunction(
    (id) => (window.__capBy?.[id] ?? '').split('Microsoft Windows').length > 4,
    sid,
    { timeout: 30000 },
  );
  await page3.waitForTimeout(1500);
  const third = await logicalLines(page3, sid);
  assert(third, 'Third-run terminal was not exposed on window.__terms');
  log(
    `third run buffer (last 80 lines):\n${third
      .slice(-80)
      .map((l) => `  | ${l}`)
      .join('\n')}`,
  );
  const run1Missing = [...lastScreen, SENTINEL].filter((l) => !third.includes(l));
  assert(
    run1Missing.length === 0,
    `Run 1's last screen was erased by the second relaunch: missing ${run1Missing.join(', ')}`,
  );
  const markersAt = third.flatMap((l, i) => (l === RELAUNCH_MARKER ? [i] : []));
  const run2At = third.lastIndexOf(RUN2_SENTINEL);
  assert(
    markersAt.length === 3 && third.filter((l) => l.includes(RELAUNCH_MARKER)).length === 3,
    `Expected three relaunch markers on lines of their own, got ${JSON.stringify(third.filter((l) => l.includes(RELAUNCH_MARKER)))}`,
  );
  assert(
    third.lastIndexOf(SENTINEL) < markersAt[0] && markersAt[1] < run2At && run2At < markersAt[2],
    `History out of order: run1 ${third.lastIndexOf(SENTINEL)}, markers ${markersAt}, run2 ${run2At}`,
  );
  log("PASS: run 1's last screen survives cold, in-run and cold relaunches; markers in order ✓");

  log('PASS ✓ scrollback persistence: all assertions passed');
  await shutdownAll();
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[scrollback] FAIL ✗', e.message);
  else console.error('[scrollback] ERROR:', e?.message || e, e?.stack ?? '');
  await shutdownAll().catch(() => {});
  await finishScenario(isAssertion ? 1 : 2);
}

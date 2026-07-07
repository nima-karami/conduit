/**
 * Session/persistence churn — create many sessions, then drive rapid busy/idle mutations. Each
 * mutation re-serializes the full session list and re-broadcasts per-window state, so this
 * measures how the persistence path holds up, plus the synchronous flushStateSync cost at quit.
 *
 * Uses a fixed user-data dir across TWO launches (not runStress) so it can assert restore.
 *
 * Invariants (fail the lane): all sessions are created; on relaunch they restore. Advisory:
 * state-broadcast count during churn, quit (flush) duration, frames during churn.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  closeApp,
  emitReport,
  launchApp,
  makeLog,
  openSession,
  startPerf,
  stopPerf,
  tapBridge,
} from './harness-stress.mjs';

const N_SESSIONS = 8;
const CHURN_MS = 5000;
const log = makeLog('persistence-churn');

if (process.platform !== 'win32') {
  console.log('[persistence-churn] SKIP — lane is Windows-only (non-win32 platform)');
  process.exit(0);
}

const udd = mkdtempSync(join(tmpdir(), 'conduit-persist-udd-'));
let exitCode = 0;
let l1 = null;
try {
  l1 = await launchApp({ userDataDir: udd });
  const { app, page } = l1;

  const sids = [];
  for (let i = 0; i < N_SESSIONS; i++) {
    const dir = mkdtempSync(join(tmpdir(), `conduit-persist-${i}-`));
    sids.push(await openSession(page, { path: dir }));
  }
  const created = await page.evaluate(() => window.__sessions.length);
  log(`created ${created} sessions`);
  assertInvariant(created >= N_SESSIONS, `expected ${N_SESSIONS} sessions, got ${created}`);

  // Count host state broadcasts across a churn window of quick per-session commands.
  await page.evaluate(() => {
    window.__stateCount = 0;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') window.__stateCount++;
    });
  });
  await startPerf(page, 'persistence-churn');
  const churnStart = Date.now();
  while (Date.now() - churnStart < CHURN_MS) {
    for (const s of sids) {
      await page.evaluate(
        (sid) => window.agentDeck.post({ type: 'term:input', sessionId: sid, data: 'echo x\r' }),
        s,
      );
    }
    await page.waitForTimeout(120);
  }
  const report = await stopPerf(page);
  const stateCount = await page.evaluate(() => window.__stateCount);
  log(`state broadcasts during churn = ${stateCount}`);

  // Quit cost — flushStateSync runs synchronously in before-quit, so close duration ≈ flush cost.
  const quitStart = Date.now();
  await closeApp(app, page);
  const quitMs = Date.now() - quitStart;
  log(`quit (flush) took ${quitMs}ms`);

  emitReport('persistence-churn', report, {
    sessions: created,
    stateBroadcasts: stateCount,
    quitMs,
  });

  // INVARIANT: relaunch against the same profile restores the sessions.
  const l2 = await launchApp({ userDataDir: udd });
  try {
    await tapBridge(l2.page);
    const restored = await l2.page
      .waitForFunction((n) => (window.__sessions || []).length >= n, N_SESSIONS, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const restoredCount = await l2.page.evaluate(() => (window.__sessions || []).length);
    log(`restored ${restoredCount} sessions on relaunch`);
    assertInvariant(restored, `expected >= ${N_SESSIONS} sessions restored, got ${restoredCount}`);
  } finally {
    await closeApp(l2.app, l2.page).catch(() => {});
    await l2.cleanup().catch(() => {});
  }

  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    exitCode = 1;
  } else {
    console.error('[persistence-churn] ERROR:', e?.stack || e?.message || e);
    exitCode = 2;
  }
} finally {
  try {
    if (l1) await l1.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(exitCode);
}

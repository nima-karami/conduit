/**
 * Whole-app stress — two parts:
 *   1. Probe self-check: an idle window reads smooth frames; a deliberately main-thread-blocking
 *      window reads inflated gaps + long tasks. Proves the probe actually detects jank (otherwise
 *      every other scenario's green numbers would be meaningless).
 *   2. Combined contention: a terminal firehose + a medium arch corpus + a file-heavy project all
 *      at once, measuring frames while the canvas mounts under the flood.
 *
 * Invariants (fail the lane): the probe distinguishes busy from idle; the app stays functional
 * (the terminal still echoes a marker after the combined load).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  makeManyFiles,
  openArchCanvas,
  openSession,
  runStress,
  seedArchCorpus,
  startPerf,
  stopPerf,
  waitForShellReady,
} from './harness-stress.mjs';

runStress('whole-app', async ({ page, log }) => {
  // ── Part 1: probe self-check ────────────────────────────────────────────────
  await startPerf(page, 'idle');
  await page.waitForTimeout(1500);
  const idle = await stopPerf(page);

  await startPerf(page, 'busy');
  // Four ~250ms main-thread blocks (each a long task), with brief gaps so the rAF loop can record
  // the stalls between them.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let bursts = 0;
        const burst = () => {
          const t = performance.now();
          while (performance.now() - t < 250) {
            /* block the main thread */
          }
          if (++bursts < 4) setTimeout(burst, 40);
          else resolve();
        };
        setTimeout(burst, 40);
      }),
  );
  const busy = await stopPerf(page);
  log(
    `self-check idle block=${idle.lag.totalMs}ms busy block=${busy.lag.totalMs}ms ` +
      `busy stalls=${busy.lag.stalls}`,
  );

  // INVARIANT: the probe's main-thread-lag metric detects the deliberate jank (this is what makes
  // every other scenario's block numbers trustworthy). ~1000ms of blocking should dwarf idle.
  assertInvariant(
    busy.lag.totalMs > idle.lag.totalMs + 400,
    `probe should detect jank: busy block ${busy.lag.totalMs}ms not clearly > idle ${idle.lag.totalMs}ms`,
  );
  assertInvariant(
    busy.lag.stalls >= 3,
    `busy window should register main-thread stalls, got ${busy.lag.stalls}`,
  );

  // ── Part 2: combined contention ─────────────────────────────────────────────
  // Open a 300-node canvas over a file-heavy project first, THEN flood the terminal and interact
  // with the canvas under that flood — measuring canvas responsiveness while the host services a
  // firehose. (Opening the command palette *during* the flood is racy; the flood is the load, not
  // the thing under test.)
  const root = mkdtempSync(join(tmpdir(), 'conduit-whole-app-'));
  seedArchCorpus(root, { nodeCount: 300, edgeCount: 1200 });
  makeManyFiles(join(root, 'many'), 3000);
  const sid = await openSession(page, { path: root });
  await waitForShellReady(page, sid);

  const opened = await openArchCanvas(page);
  assertInvariant(opened, 'architecture canvas should open');
  await page.waitForFunction(
    () => {
      const g = window.__archDoc?.graphs?.[window.__archGraphId];
      return g && g.nodes.length >= 300;
    },
    null,
    { timeout: 40000 },
  );

  // Flood the terminal in the background.
  await page.evaluate(
    (s) =>
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: 'for /L %i in (1,1,100000) do @echo WHOLEAPP_%i_AAAAAAAAAAAAAAAAAAAA\r',
      }),
    sid,
  );

  // Drag a node on the canvas WHILE the firehose runs; measure the combined jank.
  await startPerf(page, 'whole-app');
  const box = await page.evaluate(() => {
    const el = document.querySelector('.react-flow__node');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 12 };
  });
  assertInvariant(!!box, 'a node should be mounted to drag');
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + i * 6, box.y + i * 3);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const report = await stopPerf(page);

  // Stop the firehose and confirm the app is still functional.
  await page.evaluate(
    (s) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: '\x03' }),
    sid,
  );
  await page.waitForTimeout(1000);
  await page.evaluate((s) => {
    window.__cap = '';
    window.agentDeck.post({ type: 'term:input', sessionId: s, data: 'echo WHOLEAPP_OK_5551\r' });
  }, sid);
  const alive = await page
    .waitForFunction(() => (window.__cap || '').includes('WHOLEAPP_OK_5551'), null, {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false);
  log(`combined-load recovery marker seen=${alive}`);
  assertInvariant(alive, 'app should stay functional under combined load (terminal recovered)');

  emitReport('whole-app-idle', idle);
  emitReport('whole-app-busy', busy);
  emitReport('whole-app', report, { alive });
});

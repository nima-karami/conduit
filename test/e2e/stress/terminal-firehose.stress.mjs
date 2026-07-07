/**
 * Terminal firehose — a cmd `for /L` loop echoing tens of thousands of lines saturates the
 * un-coalesced `term:data` IPC path (one PTY chunk = one IPC message = one term.write). We
 * measure UI responsiveness during the flood and prove the terminal RECOVERS afterward.
 *
 * Invariant (fails the lane): after the flood + Ctrl+C, the terminal still accepts input and
 * echoes a marker — i.e. interactivity survived. Advisory: frame gaps / long tasks during the
 * flood + the term:data IPC message count and byte volume.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  openSession,
  runStress,
  startPerf,
  stopPerf,
  waitForShellReady,
} from './harness-stress.mjs';

const FLOOD_MS = 6000;

runStress('terminal-firehose', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-firehose-'));
  const sid = await openSession(page, { path: root });
  await waitForShellReady(page, sid);
  log(`session ${sid} open + shell ready`);

  // Count term:data IPC messages + bytes independently of the harness's __cap accumulator.
  await page.evaluate(() => {
    window.__td = 0;
    window.__tdBytes = 0;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'term:data') {
        window.__td++;
        window.__tdBytes += m.data.length;
      }
    });
  });

  await startPerf(page, 'terminal-firehose');
  // Interactive cmd: single-% for the loop variable. A ~60-char line, 100k times.
  await page.evaluate(
    (s) =>
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: 'for /L %i in (1,1,100000) do @echo FIREHOSE_LINE_%i_AAAAAAAAAAAAAAAAAAAAAAAAAA\r',
      }),
    sid,
  );
  await page.waitForTimeout(FLOOD_MS);
  // Ctrl+C to stop the loop, then drain briefly.
  await page.evaluate(
    (s) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: '\x03' }),
    sid,
  );
  await page.waitForTimeout(1200);
  const report = await stopPerf(page);

  const { td, bytes } = await page.evaluate(() => ({ td: window.__td, bytes: window.__tdBytes }));
  log(`term:data messages=${td} bytes=${bytes}`);

  // INVARIANT: the terminal recovered — a fresh command still echoes after the flood.
  await page.evaluate((s) => {
    window.__cap = '';
    window.agentDeck.post({
      type: 'term:input',
      sessionId: s,
      data: 'echo RECOVER_MARKER_918273\r',
    });
  }, sid);
  const recovered = await page
    .waitForFunction(() => (window.__cap || '').includes('RECOVER_MARKER_918273'), null, {
      timeout: 15000,
    })
    .then(() => true)
    .catch(() => false);

  emitReport('terminal-firehose', report, { tdMessages: td, tdBytes: bytes, recovered });

  assertInvariant(recovered, 'terminal did not echo input after the firehose — interactivity lost');
});

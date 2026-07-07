/**
 * Monaco at the 2 MB ceiling — open a ~2 MB single-line minified-JS file (Conduit caps reads at
 * 2 MB, so this sits right at the limit and is the worst case for the tokenizer). Measure the
 * open→interactive window and typing latency once loaded.
 *
 * Invariant (fails the lane): the editor mounts with a model (truncation banner tolerated).
 * Advisory: open time, typing input latency, frames during open.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  makeBigMinifiedFile,
  measureUntil,
  openSession,
  runStress,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';

runStress('monaco-2mb', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-monaco-2mb-'));
  makeBigMinifiedFile(join(root, 'huge.min.js'));
  await openSession(page, { path: root });

  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 25000 });

  const openStart = Date.now();
  await startPerf(page, 'monaco-2mb');
  await page.locator('.filerow', { hasText: 'huge.min.js' }).first().click();
  // Wait for a Monaco model carrying the (capped) content.
  await page.waitForFunction(
    () => {
      const mon = window.monaco;
      if (!mon) return false;
      return mon.editor.getModels().some((m) => m.getValueLength() > 100000);
    },
    null,
    { timeout: 30000 },
  );
  await page.waitForSelector('.monaco-editor', { state: 'visible', timeout: 10000 });
  const report = await stopPerf(page);
  const openMs = Date.now() - openStart;

  const modelLen = await page.evaluate(() =>
    Math.max(0, ...window.monaco.editor.getModels().map((m) => m.getValueLength())),
  );
  log(`editor open in ${openMs}ms, model length=${modelLen}`);
  assertInvariant(modelLen > 100000, `expected a large model, got length ${modelLen}`);

  // Typing responsiveness: focus the editor, type a char, and time until the model reflects it.
  await page.locator('.monaco-editor .view-lines').first().click();
  const baseLen = await page.evaluate(() =>
    Math.max(0, ...window.monaco.editor.getModels().map((m) => m.getValueLength())),
  );
  const typeLatencyMs = await measureUntil(
    page,
    () => page.keyboard.type('x'),
    (len) => Math.max(0, ...window.monaco.editor.getModels().map((m) => m.getValueLength())) > len,
    { timeout: 15000, arg: baseLen },
  );
  log(`typing latency=${typeLatencyMs}ms`);

  emitReport('monaco-2mb', report, { openMs, modelLen, typeLatencyMs });
});

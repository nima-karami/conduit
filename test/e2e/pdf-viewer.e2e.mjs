/**
 * In-app PDF viewer (2026-06-19 spec) — real-app runtime proof.
 *
 * Drives the REAL Electron host so the pdf.js worker actually loads (a unit test
 * cannot prove the bundled out/pdf.worker.js wires up under the file:// renderer +
 * CSP). Opens a committed multi-page fixture PDF (2 pages, selectable text, a 2-entry
 * outline) and asserts:
 *   1. pages render to <canvas> (page count shown in the toolbar);
 *   2. zoom changes the rendered canvas scale (canvas width grows);
 *   3. the text layer exists with selectable text (the page-1 term is present);
 *   4. find highlights a known term (a .pdfview__hl span appears);
 *   5. the outline sidebar lists the fixture's entries.
 *
 * Windows only. NOTE: run-smoke may report a TIMEOUT on the shared app.close()
 * cleanup under hidden launch — that is not a failure as long as the in-scenario
 * assertions below printed PASS.
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[pdf-viewer] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('pdf-viewer');
const FIXTURE = join(REPO, 'test', 'e2e', 'fixtures', 'sample.pdf');

let launched = null;
let repoDir = null;
try {
  // Seed a throwaway folder with the fixture at its root so it's a top-level file row.
  repoDir = mkdtempSync(join(tmpdir(), 'conduit-pdf-'));
  copyFileSync(FIXTURE, join(repoDir, 'sample.pdf'));

  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  await openSession(page, { path: repoDir.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // Switch the right pane to Files and open the fixture via the tree.
  await page.waitForSelector('.rtab', { state: 'attached', timeout: 10000 });
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.rtab')).find(
      (el) => el.textContent?.trim() === 'Files',
    );
    if (tab) tab.click();
  });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.filerow__name')).some(
        (el) => el.textContent === 'sample.pdf',
      ),
    null,
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.filerow__name')).find(
      (e) => e.textContent === 'sample.pdf',
    );
    el?.closest('.filerow')?.click();
  });

  // ── Assertion 1: viewer mounts + pages render to canvas ──────────────────────
  await page.waitForSelector('.pdfview', { state: 'attached', timeout: 20000 });
  // A rendered canvas with non-zero dimensions proves the worker decoded a page.
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.pdfview__canvas');
      return c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0;
    },
    null,
    { timeout: 20000 },
  );
  const total = await page.evaluate(
    () => document.querySelector('.pdfview__pagetotal')?.textContent ?? '',
  );
  assert(/\/\s*2/.test(total), `toolbar must show "/ 2" pages, got "${total}"`);
  log(`PASS 1: pages rendered to canvas; page count shows "${total.trim()}" ✓`);

  const canvasWidth = () =>
    page.evaluate(() => document.querySelector('.pdfview__canvas')?.width ?? 0);
  const beforeW = await canvasWidth();

  // ── Assertion 3: text layer has selectable text ──────────────────────────────
  await page.waitForFunction(
    () => {
      const tl = document.querySelector('.textLayer');
      return !!tl && (tl.textContent ?? '').toLowerCase().includes('conduit');
    },
    null,
    { timeout: 15000 },
  );
  log('PASS 3: text layer present with selectable text ("Conduit") ✓');

  // ── Assertion 2: zoom changes the rendered canvas scale ──────────────────────
  await page.click('.pdfview__btn[aria-label="Zoom in"]');
  await page.click('.pdfview__btn[aria-label="Zoom in"]');
  await page.waitForFunction(
    (before) => {
      const c = document.querySelector('.pdfview__canvas');
      return c instanceof HTMLCanvasElement && c.width > before;
    },
    beforeW,
    { timeout: 15000 },
  );
  const afterW = await canvasWidth();
  assert(afterW > beforeW, `zoom must enlarge the canvas (before=${beforeW}, after=${afterW})`);
  log(`PASS 2: zoom enlarged the rendered canvas (${beforeW} → ${afterW}px) ✓`);

  // ── Assertion 4: find highlights a known term ────────────────────────────────
  await page.click('.pdfview__btn[aria-label="Find"]');
  await page.waitForSelector('.pdfview__findinput', { state: 'visible', timeout: 10000 });
  await page.fill('.pdfview__findinput', 'Conduit');
  await page.waitForSelector('.pdfview__hl', { state: 'attached', timeout: 15000 });
  const hlCount = await page.evaluate(() => document.querySelectorAll('.pdfview__hl').length);
  assert(hlCount > 0, 'find must produce at least one highlighted span');
  const findCount = await page.evaluate(
    () => document.querySelector('.pdfview__findcount')?.textContent ?? '',
  );
  log(`PASS 4: find highlighted "Conduit" (${hlCount} span(s), count="${findCount.trim()}") ✓`);

  // ── Assertion 5: outline sidebar lists the fixture's entries ──────────────────
  await page.click('.pdfview__btn[aria-label="Toggle sidebar"]');
  await page.waitForSelector('.pdfview__sidebar', { state: 'visible', timeout: 10000 });
  // Outline is the default sidebar tab.
  await page.waitForSelector('.pdfview__outitem', { state: 'attached', timeout: 15000 });
  const outlineTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pdfview__outitem')).map((e) => e.textContent),
  );
  assert(
    outlineTitles.some((t) => /First Section/.test(t ?? '')),
    `outline must list the fixture entries, got ${JSON.stringify(outlineTitles)}`,
  );
  log(`PASS 5: outline sidebar lists entries ${JSON.stringify(outlineTitles)} ✓`);

  // Evidence screenshot to the OS temp scratch dir (never the repo).
  const shot = join(process.env.TEMP || tmpdir(), 'claude-scratch', 'pdf-viewer.png');
  try {
    await page.screenshot({ path: shot });
    log(`screenshot: ${shot}`);
  } catch {
    /* non-fatal */
  }

  log('All assertions passed ✓');
  await launched.cleanup();
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[pdf-viewer] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    await launched?.cleanup();
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}

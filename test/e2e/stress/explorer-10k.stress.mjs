/**
 * File explorer at 10k entries — a flat directory of 10,000 files. The tree is virtualized
 * (webview/tree-window.ts), so the load-bearing INVARIANT is that only a windowed screenful of
 * `.filerow`s mounts, never all 10k. Advisory: directory load time + scroll frame cadence.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  makeManyFiles,
  openSession,
  runStress,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';

const FILE_COUNT = 10000;
const WINDOW_CEILING = 300; // generous: a screenful + overscan is ~tens of rows

runStress('explorer-10k', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-explorer-10k-'));
  makeManyFiles(root, FILE_COUNT);
  await openSession(page, { path: root });

  const loadStart = Date.now();
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 25000 });
  await page.waitForFunction(
    (n) => (window.__conduitFilesPerf?.totalRowCount ?? 0) >= n,
    FILE_COUNT,
    { timeout: 30000 },
  );
  const loadMs = Date.now() - loadStart;

  const perf = await page.evaluate(() => window.__conduitFilesPerf);
  const domRows = await page.evaluate(() => document.querySelectorAll('.filerow').length);
  log(
    `total=${perf.totalRowCount} mounted=${perf.mountedRowCount} dom=${domRows} loadMs=${loadMs}`,
  );

  // INVARIANT: the tree windows — mounted rows are a screenful, not the whole 10k.
  assertInvariant(
    perf.totalRowCount >= FILE_COUNT,
    `total rows ${perf.totalRowCount} < ${FILE_COUNT}`,
  );
  assertInvariant(
    perf.mountedRowCount < WINDOW_CEILING,
    `mounted rows (${perf.mountedRowCount}) must be a windowed screenful, not ~${FILE_COUNT}`,
  );
  assertInvariant(domRows < WINDOW_CEILING, `DOM .filerow count (${domRows}) must stay windowed`);

  // Scroll through the list and measure the frame cadence of the virtualizer.
  await startPerf(page, 'explorer-10k');
  for (let i = 1; i <= 40; i++) {
    await page.locator('.right__scroll--files').evaluate((el, step) => {
      el.scrollTop = step * 400;
      el.dispatchEvent(new Event('scroll'));
    }, i);
    await page.waitForTimeout(16);
  }
  const report = await stopPerf(page);

  // Still windowed after scrolling to the bottom.
  const afterScroll = await page.evaluate(() => window.__conduitFilesPerf.mountedRowCount);
  assertInvariant(
    afterScroll < WINDOW_CEILING,
    `mounted rows after scroll (${afterScroll}) must stay windowed`,
  );

  emitReport('explorer-10k', report, {
    totalRows: perf.totalRowCount,
    mountedRows: perf.mountedRowCount,
    loadMs,
  });
});

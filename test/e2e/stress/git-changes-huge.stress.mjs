/**
 * Review "Changes" with a huge untracked file — the load path that used to freeze the host on a
 * synchronous readFileSync (spec 2026-07-07). Opening the session runs gitChanges (now async +
 * streamed); the file must load with the host RESPONSIVE and be marked oversize in Review.
 *
 * Invariant (fails the lane): the host stays responsive during the Changes load (bounded max stall)
 * AND the big file shows the oversize placeholder. Advisory: load block/stall.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  emitReport,
  gitCommitAll,
  initGitRepo,
  openSession,
  runStress,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';

const BIG_BYTES = 3 * 1024 * 1024; // > the 2 MB diff cap

runStress('git-changes-huge', async ({ page, log }) => {
  const repo = mkdtempSync(join(tmpdir(), 'conduit-changes-huge-'));
  initGitRepo(repo);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  gitCommitAll(repo, 'init');
  // A big UNTRACKED file (the case that froze the host) + a couple of normal edits.
  writeFileSync(join(repo, 'huge.log'), 'x'.repeat(BIG_BYTES));
  writeFileSync(join(repo, 'a.txt'), 'hello\nworld\n');

  // Measure the Changes load (gitChanges runs on session open / project info).
  await startPerf(page, 'git-changes-huge');
  await openSession(page, { path: repo });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  // Wait for the big file's card to mount + its diff to resolve to the oversize notice.
  const oversizeShown = await page
    .waitForSelector('.rcard__notice--oversize', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const report = await stopPerf(page);

  log(`oversize notice shown=${oversizeShown}`);
  emitReport('git-changes-huge', report, { oversizeShown });

  // Host stayed responsive: no multi-second freeze during the Changes load.
  assertInvariant(
    report.lag.maxMs < 4000,
    `Changes load stalled the host ${report.lag.maxMs}ms — the readFileSync freeze is back`,
  );
  assertInvariant(oversizeShown, 'the >2MB untracked file should show the oversize placeholder');
});

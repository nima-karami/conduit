/**
 * Working-tree diff of a huge file — a >2 MB working file used to be read whole and shipped over
 * IPC. Now readDiff stats first and returns a typed oversize marker without buffering the file.
 *
 * Invariant (fails the lane): the fileDiff reply is oversize (content NOT shipped) and the host
 * stays responsive. Advisory: diff block/stall + reply time.
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

runStress('git-diff-huge', async ({ page, log }) => {
  const repo = mkdtempSync(join(tmpdir(), 'conduit-diff-huge-'));
  initGitRepo(repo);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  gitCommitAll(repo, 'init');
  // A tracked file, then a >2 MB modification (100k lines × ~30 chars ≈ 3 MB).
  const bigRel = 'huge.txt';
  writeFileSync(join(repo, bigRel), 'line\n');
  gitCommitAll(repo, 'add huge');
  const big = Array.from({ length: 100_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  writeFileSync(join(repo, bigRel), big);
  const absBig = join(repo, bigRel).replace(/\\/g, '/');

  const sid = await openSession(page, { path: repo });
  log(`session ${sid} open`);

  const t0 = Date.now();
  await startPerf(page, 'git-diff-huge');
  const dto = await page.evaluate(
    (p) =>
      new Promise((resolve) => {
        window.agentDeck.subscribe((m) => {
          if (m.type === 'fileDiff' && m.doc.path === p) {
            resolve({ oversize: m.doc.oversize ?? null, workLen: m.doc.work.length });
          }
        });
        window.agentDeck.post({ type: 'readDiff', path: p });
      }),
    absBig,
  );
  const report = await stopPerf(page);
  const replyMs = Date.now() - t0;

  log(`oversize=${JSON.stringify(dto.oversize)} workLen=${dto.workLen} replyMs=${replyMs}`);
  emitReport('git-diff-huge', report, { oversizeBytes: dto.oversize?.bytes ?? 0, replyMs });

  assertInvariant(!!dto.oversize, 'a >2MB working file should be flagged oversize');
  assertInvariant(dto.workLen === 0, 'oversize file content must NOT be shipped');
  assertInvariant(report.lag.maxMs < 4000, `diff read stalled the host ${report.lag.maxMs}ms`);
});

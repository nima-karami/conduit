/**
 * Commit diff over a huge changeset — a single commit touching 1500 files. Before the caps this
 * looped `git show` sequentially over every file with no total budget (minutes-long "Loading…").
 * Now the file count is capped and the blob reads run with bounded concurrency, so the result
 * returns promptly with a truncation flag.
 *
 * Invariant (fails the lane): the commitDiff result returns within the scenario budget with the
 * file count capped + `truncated` set. Advisory: load block/stall + reply time.
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

const FILE_COUNT = 1500; // > MAX_DIFF_FILES (1000)

runStress('git-commit-huge', async ({ page, log }) => {
  const repo = mkdtempSync(join(tmpdir(), 'conduit-commit-huge-'));
  initGitRepo(repo);
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(repo, `f${String(i).padStart(4, '0')}.txt`), `content ${i}\n`);
  }
  const sha = gitCommitAll(repo, 'many files');
  const sid = await openSession(page, { path: repo });

  const t0 = Date.now();
  await startPerf(page, 'git-commit-huge');
  const result = await page.evaluate(
    ({ s, sha, root }) =>
      new Promise((resolve) => {
        window.agentDeck.subscribe((m) => {
          if (m.type === 'git:commitDiffResult' && m.sha === sha) {
            resolve({ files: m.files.length, truncated: m.truncated ?? null });
          }
        });
        window.agentDeck.post({ type: 'git:commitDiff', sessionId: s, sha, root });
      }),
    { s: sid, sha, root: repo.replace(/\\/g, '/') },
  );
  const report = await stopPerf(page);
  const replyMs = Date.now() - t0;

  log(`files=${result.files} truncated=${JSON.stringify(result.truncated)} replyMs=${replyMs}`);
  emitReport('git-commit-huge', report, {
    files: result.files,
    total: result.truncated?.total ?? result.files,
    replyMs,
  });

  assertInvariant(!!result.truncated, `a ${FILE_COUNT}-file commit should be truncated`);
  assertInvariant(result.files <= 1000, `files should be capped at 1000, got ${result.files}`);
  assertInvariant(result.truncated.total === FILE_COUNT, `total should be ${FILE_COUNT}`);
});

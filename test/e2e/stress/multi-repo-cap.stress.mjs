/**
 * 200 repos at the scan cap (docs/specs/2026-10-16-multi-repo-tracking.md §6 stress lane (b)):
 * one session over a non-git workspace holding REPO_SCAN_CAP repos, four agents writing in four
 * of them. Gating: alive, the cap is respected, and git traffic after the writers stop does not
 * keep growing. The git counts and lag are recorded for the engine's before/after.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGitProbe, readGitProbe, resetGitProbe } from '../git-probe.mjs';
import { runScenario } from '../harness.mjs';
import {
  assertInvariant,
  emitReport,
  openSession,
  startPerf,
  stopPerf,
  waitForShellReady,
} from './harness-stress.mjs';
import {
  gitStats,
  installChangeObserver,
  lagStats,
  machineIdle,
  makeRepoFarm,
  readFirstSeen,
  readHostLag,
  readRefreshedAt,
  refreshLagStats,
  startHostLag,
  startWriters,
  waitForFirstFill,
} from './multi-repo-harness.mjs';

const NAME = 'multi-repo-cap';
const REPOS = 200;
const WRITE_MS = 10000;
const SETTLE_MS = 5000;
const IDLE_WINDOW_MS = 3000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const root = mkdtempSync(join(tmpdir(), 'conduit-multi-repo-cap-'));
process.once('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.error(`[${NAME}] fixture cleanup failed, left at ${root}:`, e?.message || e);
  }
});
const workspace = join(root, 'ws');
const buildStart = Date.now();
const repos = makeRepoFarm(workspace, { repos: REPOS, filesPerRepo: 50 });
const buildMs = Date.now() - buildStart;
const idle = await machineIdle();

runScenario(NAME, async ({ app, page, log }) => {
  log(`fixture ${buildMs}ms, machine busy=${idle.busy} idle=${idle.idle}`);
  await installGitProbe(app);
  const sid = await openSession(page, { path: workspace });
  const scanned = await page
    .waitForFunction(
      ({ id, want }) => {
        const n = (window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0;
        return n >= want ? n : false;
      },
      { id: sid, want: REPOS },
      { timeout: 60000, polling: 200 },
    )
    .then((h) => h.jsonValue())
    .catch(() =>
      page.evaluate(
        (id) => (window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0,
        sid,
      ),
    );
  const firstFillMs = await waitForFirstFill(page, sid, scanned);
  const fillGit = (await readGitProbe(app)).length;
  await waitForShellReady(page, sid);
  log(`repos=${scanned}, first fill ${firstFillMs}ms, ${fillGit} git processes through the fill`);

  await installChangeObserver(page);
  await resetGitProbe(app);
  await startHostLag(app);
  await startPerf(page, NAME);

  const writerDirs = [0, 50, 100, 150].map((i) => repos[i]);
  const writes = await startWriters(writerDirs, { durationMs: WRITE_MS });
  await pause(SETTLE_MS);
  const settleEnd = Date.now();
  const calls = await readGitProbe(app);
  const stats = gitStats(calls, new Set(writerDirs.map(norm)), settleEnd, IDLE_WINDOW_MS);
  const lag = lagStats(writes, await readFirstSeen(page), sid);
  const refreshLag = refreshLagStats(writes, await readRefreshedAt(page), sid);
  const hostLag = await readHostLag(app);

  await pause(IDLE_WINDOW_MS);
  const idleGitAfter2 = (await readGitProbe(app)).filter(
    (c) => c.at > settleEnd && c.at <= settleEnd + IDLE_WINDOW_MS,
  ).length;
  const perf = await stopPerf(page);
  const finalRepos = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0,
    sid,
  );

  log(
    `git=${stats.gitTotal} status=${stats.statusTotal} numstat=${stats.numstatTotal} ` +
      `statusPerRepoMax=${stats.statusPerRepoMax} statusCwds=${stats.statusCwds} ` +
      `outsideWritten=${stats.statusOutsideWritten}/${stats.statusOutsideWrittenCwds}cwds ` +
      `lag p50=${lag.p50} p95=${lag.p95} seen=${lag.seen}/${lag.n} ` +
      `hostLag p95=${hostLag.p95} max=${hostLag.max} idleGitAfter=${stats.idleGitAfter} then ${idleGitAfter2}`,
  );
  emitReport(NAME, perf, {
    idle,
    buildMs,
    repos: finalRepos,
    firstFillMs,
    fillGit,
    ...stats,
    arrivalLag: lag,
    refreshLag,
    hostLag,
    idleGitAfter2,
  });

  assertInvariant(finalRepos === REPOS, `scan cap: expected ${REPOS} repos, got ${finalRepos}`);
  assertInvariant(
    idleGitAfter2 <= stats.idleGitAfter,
    `git kept growing after the writers stopped: ${stats.idleGitAfter} then ${idleGitAfter2} calls per ${IDLE_WINDOW_MS}ms`,
  );
  // Engine invariants (docs/plans/2026-10-16-multi-repo-tracking.plan.md T2.9).
  const perRepoCap = Math.ceil(WRITE_MS / 1000) + 2;
  assertInvariant(
    stats.statusOutsideWritten === 0,
    `${stats.statusOutsideWritten} status runs in ${stats.statusOutsideWrittenCwds} repos nobody wrote`,
  );
  assertInvariant(
    stats.statusPerRepoMax <= perRepoCap,
    `a written repo ran status ${stats.statusPerRepoMax} times in ${WRITE_MS}ms (cap ${perRepoCap})`,
  );
});

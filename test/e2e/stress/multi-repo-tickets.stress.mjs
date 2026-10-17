/**
 * The ticket topology under concurrent agents (docs/specs/2026-10-16-multi-repo-tracking.md §1,
 * §6 S0): a non-git parent over 20 repos + 4 ticket folders of 4 worktrees each, four ticket
 * agents plus one in a parent-owned main repo writing continuously. Phase A: parent alone on
 * screen. Phase B: ticket 0 in the split pane beside it. Then the stale-ticket check: a commit
 * inside ticket 0 while it is active.
 *
 * Gating (holds on main): the app stays alive, the parent sees agent files, and git traffic
 * after the writers stop does not keep growing. Everything else is recorded, not asserted —
 * the engine flips the git-count and commit-seen rows to invariants (plan T2.9).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
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
  makeTicketTopology,
  openSplit,
  readFirstSeen,
  readHostLag,
  readRefreshedAt,
  refreshLagStats,
  startHostLag,
  startWriters,
  statusPerRepoCap,
  waitForFirstFill,
} from './multi-repo-harness.mjs';

const NAME = 'multi-repo-tickets';
const WRITE_MS = 10000;
const SETTLE_MS = 5000;
const IDLE_WINDOW_MS = 3000;
const COMMIT_SEEN_MS = 5000;
const EXPECTED_PARENT_REPOS = 36;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const root = mkdtempSync(join(tmpdir(), 'conduit-multi-repo-tickets-'));
process.once('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.error(`[${NAME}] fixture cleanup failed, left at ${root}:`, e?.message || e);
  }
});
const buildStart = Date.now();
const topo = makeTicketTopology(root);
const buildMs = Date.now() - buildStart;
const idle = await machineIdle();

/** Removes a phase's agent files and seed edit so the next phase's names are new again. */
function resetWorkTrees(dirs) {
  for (const dir of dirs) {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: dir,
      windowsHide: true,
    })
      .toString()
      .split(/\r?\n/)
      .filter(Boolean);
    for (const f of untracked) unlinkSync(join(dir, f));
    execFileSync('git', ['checkout', '--', 'seed-0.txt'], { cwd: dir, windowsHide: true });
  }
}

async function resetObserver(page) {
  await page.evaluate(() => {
    window.__firstSeen = {};
    window.__refreshedAt = {};
    window.__changeMsgs = {};
  });
}

runScenario(NAME, async ({ app, page, log }) => {
  log(`fixture ${buildMs}ms, machine busy=${idle.busy} idle=${idle.idle}`);
  await installGitProbe(app);

  const ticketIds = [];
  for (const t of topo.tickets) ticketIds.push(await openSession(page, { path: t.dir }));
  const parent = await openSession(page, { path: topo.workspace });

  const parentRepos = await page
    .waitForFunction(
      ({ sid, want }) => {
        const n = (window.__sessions || []).find((s) => s.id === sid)?.repos?.length ?? 0;
        return n === want ? n : false;
      },
      { sid: parent, want: EXPECTED_PARENT_REPOS },
      { timeout: 60000, polling: 200 },
    )
    .then((h) => h.jsonValue())
    .catch(() =>
      page.evaluate(
        (sid) => (window.__sessions || []).find((s) => s.id === sid)?.repos?.length ?? 0,
        parent,
      ),
    );
  log(`parent repos=${parentRepos} (expected ${EXPECTED_PARENT_REPOS})`);
  const firstFillMs = await waitForFirstFill(page, parent, parentRepos);
  const fillGit = (await readGitProbe(app)).length;
  await waitForShellReady(page, parent);
  log(`first fill ${firstFillMs}ms, ${fillGit} git processes through the fill`);

  await installChangeObserver(page);
  await resetGitProbe(app);
  await startHostLag(app);
  await startPerf(page, NAME);

  const writerDirs = [...topo.tickets.map((t) => t.worktrees[0].dir), topo.repos[5]];
  const writtenKeys = new Set(writerDirs.map(norm));

  async function phase(label) {
    const writes = await startWriters(writerDirs, { durationMs: WRITE_MS });
    await pause(SETTLE_MS);
    const settleEnd = Date.now();
    const calls = await readGitProbe(app);
    const firstSeen = await readFirstSeen(page);
    const refreshed = await readRefreshedAt(page);
    const hostLag = await readHostLag(app);
    const stats = gitStats(calls, writtenKeys, settleEnd, IDLE_WINDOW_MS);
    const parentLag = lagStats(writes, firstSeen, parent);
    const t0Writes = writes.filter((w) => w.dir === writerDirs[0]);
    const result = {
      ...stats,
      writes: writes.length,
      arrivalLag: parentLag,
      refreshLag: refreshLagStats(writes, refreshed, parent),
      seenRatio: parentLag.n ? parentLag.seen / parentLag.n : 0,
      ticket0Lag: lagStats(t0Writes, firstSeen, ticketIds[0]),
      hostLag,
    };
    log(
      `${label}: git=${stats.gitTotal} status=${stats.statusTotal} numstat=${stats.numstatTotal} ` +
        `statusPerRepoMax=${stats.statusPerRepoMax} statusCwds=${stats.statusCwds} ` +
        `outsideWritten=${stats.statusOutsideWritten}/${stats.statusOutsideWrittenCwds}cwds ` +
        `lag p50=${parentLag.p50} p95=${parentLag.p95} max=${parentLag.max} ` +
        `seen=${parentLag.seen}/${parentLag.n} hostLag p95=${hostLag.p95} max=${hostLag.max} ` +
        `idleGitAfter=${stats.idleGitAfter}`,
    );
    return { result, writes, settleEnd };
  }

  const { result: phaseA } = await phase('A parent only');

  resetWorkTrees(writerDirs);
  await openSplit(page, ticketIds[0]);
  await pause(3000);
  await resetObserver(page);
  await resetGitProbe(app);
  await readHostLag(app);
  const {
    result: phaseB,
    writes: writesB,
    settleEnd: settleB,
  } = await phase('B parent + ticket0 split');

  await pause(IDLE_WINDOW_MS);
  const afterB = await readGitProbe(app);
  const idleGitAfter2 = afterB.filter(
    (c) => c.at > settleB && c.at <= settleB + IDLE_WINDOW_MS,
  ).length;
  const perf = await stopPerf(page);

  // Stale-ticket check (spec §2): commit inside ticket 0 while it is the active session.
  await page.locator(`.session[data-sessionid="${ticketIds[0]}"]`).click();
  const committed = writesB.filter((w) => w.dir === writerDirs[0]).map((w) => w.name);
  const shown = await page
    .waitForFunction(
      // Agent names are unique per writer dir, so the union over the ticket's repos is exact.
      ({ sid, names }) => {
        const shownNow = new Set(Object.values(window.__repoNames?.[sid] ?? {}).flat());
        return names.every((n) => shownNow.has(n));
      },
      { sid: ticketIds[0], names: committed },
      { timeout: 20000, polling: 100 },
    )
    .then(() => true)
    .catch(() => false);
  const wt = writerDirs[0];
  execFileSync('git', ['add', '-A'], { cwd: wt, windowsHide: true });
  execFileSync('git', ['commit', '-qm', 'x'], { cwd: wt, windowsHide: true });
  const commitAt = Date.now();
  const commitSeen = await page
    .waitForFunction(
      ({ sid, names, after }) => {
        const msg = (window.__changeMsgs?.[sid] ?? []).find(
          (m) => m.at > after && !names.some((n) => m.names.includes(n)),
        );
        return msg ? msg.at - after : false;
      },
      { sid: ticketIds[0], names: committed, after: commitAt },
      { timeout: COMMIT_SEEN_MS, polling: 50 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  const msgsAfterCommit = await page.evaluate(
    ({ sid, after }) => (window.__changeMsgs?.[sid] ?? []).filter((m) => m.at > after).length,
    { sid: ticketIds[0], after: commitAt },
  );
  log(
    `commit-seen: ticket0 showed its files=${shown}, ` +
      `${commitSeen === null ? `not seen within ${COMMIT_SEEN_MS}ms` : `${commitSeen}ms`}, ` +
      `${msgsAfterCommit} change messages after the commit`,
  );

  // Spec §7 lag AC: gated only on an idle machine; a loaded one fails PTY-bound timing the way a
  // regression does (plan T2.9).
  const lagGate = idle.idle ? 'gated' : 'skipped-loaded';
  if (!idle.idle) log(`lag gate SKIPPED: machine busy ${Math.round(idle.busy * 100)}%`);

  emitReport(NAME, perf, {
    idle,
    lagGate,
    buildMs,
    parentRepos,
    firstFillMs,
    fillGit,
    phaseA,
    phaseB,
    idleGitAfter2,
    commitSeen: {
      ticketShowedFiles: shown,
      ms: commitSeen,
      windowMs: COMMIT_SEEN_MS,
      msgsAfterCommit,
    },
  });

  assertInvariant(phaseA.seenRatio > 0, `the parent saw no agent file in phase A`);
  assertInvariant(phaseB.seenRatio > 0, `the parent saw no agent file in phase B`);
  assertInvariant(
    idleGitAfter2 <= phaseB.idleGitAfter,
    `git kept growing after the writers stopped: ${phaseB.idleGitAfter} then ${idleGitAfter2} calls per ${IDLE_WINDOW_MS}ms`,
  );
  // Engine invariants (docs/plans/2026-10-16-multi-repo-tracking.plan.md T2.9).
  const perRepoCap = statusPerRepoCap(WRITE_MS);
  for (const [label, p] of [
    ['A', phaseA],
    ['B', phaseB],
  ]) {
    assertInvariant(
      p.statusOutsideWritten === 0,
      `phase ${label}: ${p.statusOutsideWritten} status runs in ${p.statusOutsideWrittenCwds} repos nobody wrote`,
    );
    assertInvariant(
      p.statusPerRepoMax <= perRepoCap,
      `phase ${label}: a written repo ran status ${p.statusPerRepoMax} times in ${WRITE_MS}ms (cap ${perRepoCap})`,
    );
  }
  assertInvariant(
    phaseB.statusPerRepoMax <= phaseA.statusPerRepoMax + 1,
    `a second visible session added git: status per repo ${phaseA.statusPerRepoMax} → ${phaseB.statusPerRepoMax}`,
  );
  assertInvariant(
    commitSeen !== null,
    `ticket 0 did not see its commit within ${COMMIT_SEEN_MS}ms`,
  );
  if (lagGate === 'gated')
    assertInvariant(
      phaseA.refreshLag.n > 0 && phaseA.refreshLag.p95 <= 1000,
      `spec §7 lag: refreshLag p95 ${phaseA.refreshLag.p95}ms (n=${phaseA.refreshLag.n}) is not ≤ 1000ms for the parent`,
    );
});

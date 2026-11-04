import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from '../attention-footer-helpers.mjs';
import { installGitProbe, readGitProbe, resetGitProbe, statusCalls } from '../git-probe.mjs';
import { openChangesTab, revealSessionRow } from '../harness.mjs';
import { assertInvariant, emitReport, openSession, runStress } from './harness-stress.mjs';
import { makeManyFiles, startWriters } from './multi-repo-harness.mjs';

const NAME = 'hidden-sessions-idle';
const WRITE_MS = 120_000;
const WRITE_INTERVAL_MS = 50;
const SETTLE_MS = 3_000;
const DONE_WINDOW_MS = 12_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const root = mkdtempSync(join(tmpdir(), 'conduit-hidden-sessions-idle-'));
process.once('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Best-effort cleanup.
  }
});

function makeRepo(name, files) {
  const dir = join(root, name);
  makeManyFiles(dir, files);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  return dir.replace(/\\/g, '/');
}

const bigRepos = Array.from({ length: 10 }, (_, i) =>
  makeRepo(`repo-${String(i).padStart(2, '0')}`, 5000),
);
const showRepos = [
  makeRepo('show-1k', 1000),
  makeRepo('show-10k', 10_000),
  makeRepo('show-100k', 100_000),
];

runStress(NAME, async ({ app, page, log }) => {
  await installGitProbe(app);
  await app.evaluate(
    (_electron, repos) => {
      const fs = process.getBuiltinModule('fs');
      const watch = fs.watch;
      const key = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const roots = repos.map((r) => key(r));
      const state = {
        handlesByRepo: Object.fromEntries(roots.map((r) => [r, 0])),
        maxHandlesByRepo: Object.fromEntries(roots.map((r) => [r, 0])),
      };
      const owner = (p) => {
        const n = key(p);
        return roots.find((r) => n === r || n.startsWith(`${r}/`)) ?? null;
      };
      fs.watch = function (file, ...args) {
        const watcher = watch.call(this, file, ...args);
        const repo = owner(file);
        if (repo) {
          state.handlesByRepo[repo] += 1;
          state.maxHandlesByRepo[repo] = Math.max(
            state.maxHandlesByRepo[repo],
            state.handlesByRepo[repo],
          );
          watcher.once('close', () => {
            state.handlesByRepo[repo] = Math.max(0, state.handlesByRepo[repo] - 1);
          });
        }
        return watcher;
      };
      globalThis.__hiddenIdle = state;
    },
    [...bigRepos, ...showRepos],
  );

  await page.evaluate(() => {
    if (window.__hiddenIdleTap) return;
    window.__hiddenIdleTap = true;
    window.__hiddenIdleDelta = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'repoDelta') window.__hiddenIdleDelta.push({ at: Date.now(), msg: m });
    });
  });

  const sessionIds = [];
  for (const repo of bigRepos)
    sessionIds.push(await openSession(page, { path: repo, agentId: 'shell:cmd' }));
  const shown = sessionIds[0];
  const hidden = sessionIds.slice(1);

  await revealSessionRow(page, shown);
  await page.locator(`[data-agent-tree] .session[data-sessionid="${shown}"]`).click();
  await wait(1000);

  await resetGitProbe(app);
  const sampling = [];
  const sampleUntil = Date.now() + WRITE_MS + SETTLE_MS;
  while (Date.now() < sampleUntil) {
    const [cpu, rss, handles] = await Promise.all([
      app.evaluate((electron) => {
        const browser = electron.app.getAppMetrics().find((m) => m.type === 'Browser');
        return browser?.cpu?.percentCPUUsage ?? 0;
      }),
      app.evaluate(() => process.memoryUsage().rss),
      app.evaluate(
        (repos) =>
          Object.fromEntries(
            repos.map((r) => [r, globalThis.__hiddenIdle?.handlesByRepo?.[r] ?? 0]),
          ),
        bigRepos.map(norm),
      ),
    ]);
    sampling.push({ at: Date.now(), cpu, rss, handles });
    await wait(1000);
  }

  const writerRepos = [bigRepos[1], bigRepos[2], bigRepos[3]];
  const writesPromise = startWriters(writerRepos, {
    intervalMs: WRITE_INTERVAL_MS,
    durationMs: WRITE_MS,
  });
  const writes = await writesPromise;
  await wait(SETTLE_MS);
  const duringWriteCalls = await readGitProbe(app);
  const duringWriteStatus = statusCalls(duringWriteCalls);

  const doneAt = new Map();
  for (const sid of hidden.slice(0, 3)) {
    doneAt.set(sid, Date.now());
    await report(page, sid, 'working');
    await report(page, sid, 'done');
  }
  await wait(2_000);

  const completionSamples = await page.evaluate(
    (ids) =>
      ids.map((sid) => {
        const s = (window.__sessions || []).find((x) => x.id === sid);
        return {
          sid,
          completions: s?.completions ?? 0,
          repoGit: s?.repoGit ?? {},
        };
      }),
    hidden.slice(0, 3),
  );

  const doneCalls = await readGitProbe(app);
  const doneStatus = statusCalls(doneCalls);
  const doneWindowByRepo = Object.fromEntries(
    writerRepos.map((repo, i) => {
      const sid = hidden[i];
      const at = doneAt.get(sid) ?? 0;
      const repoKey = norm(repo);
      const calls = doneStatus.filter(
        (c) => c.cwd === repoKey && c.at >= at && c.at <= at + DONE_WINDOW_MS,
      );
      return [repoKey, calls.length];
    }),
  );

  for (const repo of writerRepos) {
    assertInvariant(
      (await app.evaluate((r) => globalThis.__hiddenIdle.handlesByRepo[r] ?? 0, norm(repo))) === 0,
      `hidden repo ${repo} holds no watch handles`,
    );
    assertInvariant(
      duringWriteStatus.filter((c) => c.cwd === norm(repo)).length === 0,
      `hidden repo ${repo} ran git status during the write window`,
    );
    assertInvariant(
      (doneWindowByRepo[norm(repo)] ?? 0) <= 2,
      `hidden repo ${repo} exceeded 2 status runs in the 12s done window`,
    );
  }

  const showSessions = [];
  for (const repo of showRepos)
    showSessions.push(await openSession(page, { path: repo, agentId: 'shell:cmd' }));
  const showLatencies = [];
  for (const sid of showSessions) {
    const shownAt = Date.now();
    await revealSessionRow(page, sid);
    await page.locator(`[data-agent-tree] .session[data-sessionid="${sid}"]`).click();
    await openChangesTab(page);
    await page.waitForFunction(
      (id) => (window.__hiddenIdleDelta || []).some((d) => d.msg.sessionId === id),
      sid,
      { timeout: 120_000 },
    );
    showLatencies.push(Date.now() - shownAt);
  }

  const avgCpu =
    sampling.length === 0 ? 0 : sampling.reduce((sum, s) => sum + s.cpu, 0) / sampling.length;
  const rssFinal = sampling.at(-1)?.rss ?? 0;
  const m1Handles = await app.evaluate(
    (repos) =>
      Object.fromEntries(
        repos.map((r) => [
          r,
          {
            live: globalThis.__hiddenIdle?.handlesByRepo?.[r] ?? 0,
            max: globalThis.__hiddenIdle?.maxHandlesByRepo?.[r] ?? 0,
          },
        ]),
      ),
    bigRepos.map(norm),
  );

  emitReport(
    NAME,
    {
      lag: { totalMs: 0, maxMs: 0, stalls: 0 },
      longTasks: { count: 0, totalMs: 0 },
      maxFrameGapMs: 0,
    },
    {
      writes: writes.length,
      samplingPoints: sampling.length,
      m1Handles,
      m2GitCalls: doneCalls.length,
      m3AvgCpu: avgCpu,
      m4RssFinal: rssFinal,
      m5ShowLatencyMs: showLatencies,
      m6CompletionSamples: completionSamples,
      doneWindowByRepo,
    },
  );

  log(
    `M1 handles tracked for ${Object.keys(m1Handles).length} repos; M2 calls=${doneCalls.length}; M3 avgCpu=${avgCpu.toFixed(2)}; M4 rss=${rssFinal}; M5 latencies=${showLatencies.join(',')}`,
  );
});

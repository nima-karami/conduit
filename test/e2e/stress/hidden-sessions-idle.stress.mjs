/**
 * Hidden sessions stay idle (docs/specs/2026-11-03-demand-driven-resources.md §8;
 * docs/plans/2026-11-03-demand-driven-resources.plan.md Task X.3).
 *
 * S-idle: ten cmd sessions, each homed in its own committed 5 000-file repo, one shown and nine
 * hidden; one hidden repo has a.ts open in an editor tab (the G6 share). Three hidden repos are
 * written at 20 files/s for 120 s while main is sampled at 1 Hz, then each reports OSC 7501
 * working → done once. S-show: three more sessions (1k / 10k / 100k files) are hidden, written
 * once, then shown in turn.
 *
 * Gating (exit 1): the nine hidden repos hold no watch throughout (the G6 repo is reported, not
 * gated), run no git during the write window, and each written repo runs ≤ 2 change-list reads in
 * the 12 s after its done. M1–M6 are advisory, and are emitted before the invariants are checked
 * so a "before" run (old behaviour) still records its numbers.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from '../attention-footer-helpers.mjs';
import { installGitProbe, readGitProbe, resetGitProbe, statusCalls } from '../git-probe.mjs';
import { openDoc } from '../goto-matrix.mjs';
import { revealSessionRow } from '../harness.mjs';
import {
  assertInvariant,
  emitReport,
  gitCommitAll,
  openSession,
  runStress,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';
import {
  installChangeObserver,
  makeRepoFarm,
  readRefreshedAt,
  startWriters,
} from './multi-repo-harness.mjs';

const NAME = 'hidden-sessions-idle';
const IDLE_FILES = 5000;
const WRITE_MS = 120_000;
const WRITE_INTERVAL_MS = 50;
const SETTLE_MS = 3000;
const DONE_WINDOW_MS = 12_000;
const SHOW_TIMEOUT_MS = 30_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
}

/** The probe's git calls whose cwd is `repo` or inside it. */
const callsIn = (calls, repo) => {
  const k = norm(repo);
  return calls.filter((c) => c.cwd === k || c.cwd.startsWith(`${k}/`));
};

runStress(NAME, async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-hidden-idle-'));
  // Runs after runStress has closed the app, whose shells pin these dirs.
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.error(`[${NAME}] fixture cleanup failed, left at ${root}:`, e?.message || e);
    }
  });
  const buildStart = Date.now();
  const idleRepos = makeRepoFarm(join(root, 'idle'), { repos: 10, filesPerRepo: IDLE_FILES });
  const showRepos = [1000, 10_000, 100_000].map(
    (n) => makeRepoFarm(join(root, `show-${n}`), { repos: 1, filesPerRepo: n })[0],
  );
  const shownRepo = idleRepos[0];
  const hiddenRepos = idleRepos.slice(1);
  const lspRepo = hiddenRepos[8];
  const writerRepos = hiddenRepos.slice(0, 3);
  writeFileSync(
    join(lspRepo, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'es2022' }, include: ['*.ts'] }),
  );
  writeFileSync(join(lspRepo, 'a.ts'), 'export const a: number = 1;\n');
  gitCommitAll(lspRepo, 'ts');
  log(`fixtures ${Date.now() - buildStart} ms`);

  await installGitProbe(app);
  await app.evaluate(
    (_electron, repos) => {
      const fs = process.getBuiltinModule('fs');
      const watch = fs.watch;
      const key = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const roots = repos.map(key);
      const owner = (p) => {
        const n = key(p);
        return roots.find((r) => n === r || n.startsWith(`${r}/`)) ?? null;
      };
      const zero = () => Object.fromEntries(roots.map((r) => [r, 0]));
      const lists = () => Object.fromEntries(roots.map((r) => [r, []]));
      const state = { all: 0, live: zero(), max: zero(), paths: lists() };
      state.resetMax = () => {
        for (const r of roots) state.max[r] = state.live[r];
        state.paths = lists();
      };
      globalThis.__hiddenIdle = state;
      fs.watch = function (file, ...args) {
        const watcher = watch.call(this, file, ...args);
        state.all++;
        const repo = owner(file);
        if (repo) {
          state.live[repo]++;
          state.max[repo] = Math.max(state.max[repo], state.live[repo]);
          state.paths[repo].push(key(file));
        }
        watcher.once('close', () => {
          state.all--;
          if (repo) state.live[repo]--;
        });
        return watcher;
      };
    },
    [...idleRepos, ...showRepos],
  );
  const watches = () =>
    app.evaluate(() => {
      const s = globalThis.__hiddenIdle;
      return { all: s.all, live: { ...s.live }, max: { ...s.max }, paths: { ...s.paths } };
    });

  await installChangeObserver(page);
  await page.evaluate(() => {
    window.__hiRepoGit = {};
    window.agentDeck.subscribe((m) => {
      if (m.type !== 'state') return;
      for (const s of m.sessions ?? []) {
        const fp = JSON.stringify(s.repoGit ?? {});
        if (!window.__hiRepoGit[s.id]) window.__hiRepoGit[s.id] = [];
        const log = window.__hiRepoGit[s.id];
        if (log.at(-1)?.fp !== fp) log.push({ at: Date.now(), fp, repoGit: s.repoGit ?? {} });
      }
    });
  });

  const ROW = (sid) => `[data-agent-tree] .session[data-sessionid="${sid}"]`;
  const activate = async (sid) => {
    await revealSessionRow(page, sid);
    await page.locator(ROW(sid)).click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute('aria-selected') === 'true',
      ROW(sid),
      { timeout: 10_000 },
    );
  };
  /** Wait until every repo in `repos` holds no live watch; returns the last read either way. */
  const waitUnwatched = async (repos, ms) => {
    const deadline = Date.now() + ms;
    let w = await watches();
    while (Date.now() < deadline && repos.some((r) => w.live[norm(r)] !== 0)) {
      await wait(200);
      w = await watches();
    }
    return w;
  };

  // ── S-idle setup: open every session; the shown one last, so the rest are hidden behind it ──
  const sidOf = new Map();
  for (const repo of hiddenRepos) {
    const sid = await openSession(page, { path: repo, agentId: 'shell:cmd' });
    sidOf.set(repo, sid);
    // Opened while its session is still the active one, so the tab belongs to it (G6 share).
    if (repo === lspRepo) await openDoc(app, page, sid, join(lspRepo, 'a.ts'));
  }
  sidOf.set(shownRepo, await openSession(page, { path: shownRepo, agentId: 'shell:cmd' }));
  await activate(sidOf.get(shownRepo));
  const gated = hiddenRepos.filter((r) => r !== lspRepo);
  const settled = await waitUnwatched(gated, 15_000);
  log(`hidden repos released: ${JSON.stringify(gated.map((r) => settled.live[norm(r)]))}`);
  // The open phase showed every session once; "throughout" starts once that has settled.
  await app.evaluate(() => globalThis.__hiddenIdle.resetMax());

  // ── S-idle: writers and 1 Hz sampling run together ─────────────────────────
  await resetGitProbe(app);
  await startPerf(page, NAME);
  const writeStart = Date.now();
  let writeEnd = Number.POSITIVE_INFINITY;
  const writesP = startWriters(writerRepos, {
    intervalMs: WRITE_INTERVAL_MS,
    durationMs: WRITE_MS,
  }).then((w) => {
    writeEnd = Date.now();
    return w;
  });
  const samples = [];
  while (Date.now() < writeEnd + SETTLE_MS) {
    const t = Date.now();
    const [cpu, w] = await Promise.all([
      app.evaluate(
        (electron) =>
          electron.app.getAppMetrics().find((m) => m.type === 'Browser')?.cpu?.percentCPUUsage ??
          null,
      ),
      watches(),
    ]);
    samples.push({ at: t, cpu, all: w.all, live: w.live });
    await wait(Math.max(0, 1000 - (Date.now() - t)));
  }
  const writes = await writesP;
  const rss = await app.evaluate(() => process.memoryUsage().rss);
  const writeCalls = await readGitProbe(app);
  log(
    `write window ${Date.now() - writeStart} ms, ${writes.length} writes, ${samples.length} samples`,
  );

  // ── Turn ends: each written repo reports working → done once ───────────────
  const doneAt = new Map();
  for (const repo of writerRepos) {
    const sid = sidOf.get(repo);
    await report(page, sid, 'working');
    doneAt.set(repo, Date.now());
    await report(page, sid, 'done');
  }
  // The whole window must have elapsed for the last done, or the ≤ 2 count reads a partial one.
  await wait(Math.max(0, Math.max(...doneAt.values()) + DONE_WINDOW_MS - Date.now()));
  const doneCalls = statusCalls(await readGitProbe(app));
  const perf = await stopPerf(page);
  const m6 = await page.evaluate(
    (rows) =>
      rows.map(({ sid, at }) => {
        const hit = (window.__hiRepoGit[sid] ?? []).find(
          (e) => e.at >= at && Object.values(e.repoGit).some((g) => g?.dirty === true),
        );
        return { sid, ms: hit ? hit.at - at : null };
      }),
    writerRepos.map((r) => ({ sid: sidOf.get(r), at: doneAt.get(r) })),
  );

  // ── S-show: three more sessions, hidden, written once, then shown in turn ──
  for (const repo of showRepos)
    sidOf.set(repo, await openSession(page, { path: repo, agentId: 'shell:cmd' }));
  await activate(sidOf.get(shownRepo));
  // M5 times a catch-up, so each show repo must really have been released first.
  const showHidden = await waitUnwatched(showRepos, 30_000);
  const showUnwatched = Object.fromEntries(
    showRepos.map((r) => [norm(r), showHidden.live[norm(r)]]),
  );
  const m5 = [];
  for (const [i, repo] of showRepos.entries()) {
    const sid = sidOf.get(repo);
    // Written while hidden, so only a catch-up run after the show can list it.
    const name = `agent-9-${i}.txt`;
    writeFileSync(join(repo, name), `${name}\n`);
    const shownAt = await app.evaluate(() => Date.now());
    await activate(sid);
    const deadline = Date.now() + SHOW_TIMEOUT_MS;
    let refreshedAt;
    while (Date.now() < deadline) {
      refreshedAt = (await readRefreshedAt(page))[sid]?.[name];
      if (refreshedAt !== undefined) break;
      await wait(50);
    }
    m5.push({
      files: [1000, 10_000, 100_000][i],
      ms: refreshedAt !== undefined ? refreshedAt - shownAt : null,
      afterShow: refreshedAt !== undefined && refreshedAt > shownAt,
    });
  }

  // ── Report, then gate ──────────────────────────────────────────────────────
  const end = await watches();
  const cpus = samples.map((s) => s.cpu).filter((c) => typeof c === 'number');
  const doneWindow = Object.fromEntries(
    writerRepos.map((repo) => {
      const at = doneAt.get(repo);
      const n = callsIn(doneCalls, repo).filter(
        (c) => c.at >= at && c.at <= at + DONE_WINDOW_MS,
      ).length;
      return [norm(repo), n];
    }),
  );
  const writeWindowGit = Object.fromEntries(
    hiddenRepos.map((r) => [
      norm(r),
      callsIn(writeCalls, r)
        .filter((c) => c.at >= writeStart)
        .map((c) => c.args.join(' ')),
    ]),
  );
  const m5At10k = m5.find((x) => x.files === 10_000)?.ms ?? null;
  emitReport(NAME, perf, {
    m1: {
      allLiveMax: Math.max(0, ...samples.map((s) => s.all)),
      shownRepoLiveMax: Math.max(0, ...samples.map((s) => s.live[norm(shownRepo)] ?? 0)),
      hiddenMax: Object.fromEntries(gated.map((r) => [norm(r), end.max[norm(r)]])),
      g6RepoMax: end.max[norm(lspRepo)],
    },
    m2: {
      writeWindow: Object.fromEntries(
        Object.entries(writeWindowGit).map(([k, v]) => [k, v.length]),
      ),
      doneWindowStatus: doneWindow,
    },
    m3MeanCpu: mean(cpus),
    m3P95Cpu: percentile(cpus, 95),
    m4RssBytes: rss,
    m5,
    m5At10kMs: m5At10k,
    m5LiveWatchesBeforeShow: showUnwatched,
    m6,
    writes: writes.length,
    samples: samples.length,
  });

  for (const repo of gated) {
    const k = norm(repo);
    assertInvariant(
      end.max[k] === 0,
      `hidden repo ${k} held up to ${end.max[k]} watch(es): ${JSON.stringify(end.paths[k] ?? [])}`,
    );
  }
  for (const repo of hiddenRepos) {
    const calls = writeWindowGit[norm(repo)];
    assertInvariant(
      calls.length === 0,
      `hidden repo ${norm(repo)} ran git during the write window: ${JSON.stringify(calls.slice(0, 10))}`,
    );
  }
  for (const [k, n] of Object.entries(showUnwatched))
    assertInvariant(n === 0, `S-show repo ${k} still held ${n} watch(es) when hidden`);
  for (const repo of writerRepos) {
    const n = doneWindow[norm(repo)];
    assertInvariant(n <= 2, `written repo ${norm(repo)} ran ${n} status reads in the done window`);
  }
  log(`M3 mean cpu ${mean(cpus)?.toFixed(2)}%, M5 ${JSON.stringify(m5)}, M6 ${JSON.stringify(m6)}`);
});

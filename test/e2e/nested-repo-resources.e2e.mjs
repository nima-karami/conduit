import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installGitProbe,
  numstatCalls,
  readGitProbe,
  resetGitProbe,
  statusCalls,
} from './git-probe.mjs';
import { assert, closeApp, openChangesTab, openSession, runScenario } from './harness.mjs';

runScenario('nested-repo-resources', async ({ app, page, log }) => {
  const fixture = mkdtempSync(join(tmpdir(), 'conduit-nested-resources-'));
  const slash = (p) => p.replace(/\\/g, '/');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const measurements = [];
  try {
    await installGitProbe(app);
    // Change lists are pushed (repoDelta), never pulled: keep each session's latest snapshots.
    await page.evaluate(() => {
      window.__deltas = {};
      window.agentDeck.subscribe((m) => {
        if (m.type !== 'repoDelta') return;
        const next = m.full ? {} : { ...(window.__deltas[m.sessionId] ?? {}) };
        for (const [r, snap] of Object.entries(m.repos)) {
          if (snap.removed) delete next[r];
          else next[r] = snap;
        }
        window.__deltas[m.sessionId] = next;
      });
    });
    await app.evaluate((_electron, prefix) => {
      const cp = process.getBuiltinModule('child_process');
      const fs = process.getBuiltinModule('fs');
      const originalWatch = fs.watch;
      const original = cp.execFile;
      globalThis.__nestedProbe = {
        calls: 0,
        active: 0,
        peak: 0,
        gaps: [],
        events: {},
        last: Date.now(),
      };
      fs.watch = function (file, ...args) {
        const watcher = originalWatch.call(this, file, ...args);
        if (String(file).replace(/\\/g, '/').toLowerCase().startsWith(prefix.toLowerCase()))
          watcher.on('change', (_event, filename) => {
            const key = String(filename);
            const events = globalThis.__nestedProbe.events;
            events[key] = (events[key] ?? 0) + 1;
          });
        return watcher;
      };
      globalThis.__nestedProbe.timer = setInterval(() => {
        const probe = globalThis.__nestedProbe;
        const now = Date.now();
        probe.gaps.push(now - probe.last);
        probe.last = now;
      }, 20);
      cp.execFile = function (bin, args, options, ...rest) {
        const child = original.call(this, bin, args, options, ...rest);
        if (bin === 'git' && String(options?.cwd).replace(/\\/g, '/').startsWith(prefix)) {
          const probe = globalThis.__nestedProbe;
          probe.calls++;
          probe.active++;
          probe.peak = Math.max(probe.peak, probe.active);
          child.once('close', () => probe.active--);
        }
        return child;
      };
    }, slash(fixture));
    const fixtureKey = slash(fixture).toLowerCase();
    /** Zero every counter; the window a measurement covers starts here. */
    async function mark() {
      await resetGitProbe(app);
      await app.evaluate(() => {
        const probe = globalThis.__nestedProbe;
        probe.calls = 0;
        probe.peak = probe.active;
        probe.gaps = [];
        probe.events = {};
        probe.cpu = process.cpuUsage();
      });
      return Date.now();
    }
    /** Git processes per repo working directory under the fixture, for one kind of call. */
    const perRepo = (calls) => {
      const per = new Map();
      for (const c of calls)
        if (c.cwd.startsWith(fixtureKey)) per.set(c.cwd, (per.get(c.cwd) ?? 0) + 1);
      return { repos: per.size, max: Math.max(0, ...per.values()) };
    };
    async function measure(label, start) {
      const metrics = await app.evaluate(() => {
        const probe = globalThis.__nestedProbe;
        const cpu = process.cpuUsage(probe.cpu);
        return {
          gitCalls: probe.calls,
          peakGit: probe.peak,
          maxHostGapMs: Math.max(0, ...probe.gaps),
          hostCpuMs: (cpu.user + cpu.system) / 1000,
          hostRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          watchEvents: probe.events,
        };
      });
      const calls = await readGitProbe(app);
      const status = perRepo(statusCalls(calls));
      const numstat = perRepo(numstatCalls(calls));
      const measurement = {
        label,
        elapsedMs: Date.now() - start,
        ...metrics,
        statusRepos: status.repos,
        statusPerRepoMax: status.max,
        numstatPerRepoMax: numstat.max,
      };
      measurements.push(measurement);
      log(JSON.stringify(measurement));
      return measurement;
    }
    /**
     * Wait for the session's pushed snapshots to satisfy `spec`: `count` repos, and optionally
     * `changes` rows each, every row of `kind`/`added`/`removed`, and `lines` counted.
     */
    async function awaitSnapshots(sid, spec, what) {
      try {
        await page.waitForFunction(
          ({ sid, spec }) => {
            const snaps = Object.values(window.__deltas[sid] ?? {});
            const is = (want, got) => want === undefined || want === got;
            return (
              snaps.length === spec.count &&
              snaps.every(
                (s) =>
                  (spec.changes === undefined || s.changes.length === spec.changes) &&
                  is(spec.lines, s.lines) &&
                  s.changes.every(
                    (c) =>
                      is(spec.kind, c.kind) &&
                      is(spec.added, c.added) &&
                      is(spec.removed, c.removed),
                  ),
              )
            );
          },
          { sid, spec },
          { timeout: 30000 },
        );
      } catch (e) {
        if (e?.name !== 'TimeoutError') throw e;
        const seen = await page.evaluate(
          (id) =>
            Object.entries(window.__deltas[id] ?? {}).map(([root, s]) => ({
              root,
              lines: s.lines,
              rows: s.changes.length,
              kinds: [...new Set(s.changes.map((c) => c.kind))],
              error: s.error,
            })),
          sid,
        );
        assert(false, `${what} (spec ${JSON.stringify(spec)}, observed ${JSON.stringify(seen)})`);
      }
      return page.evaluate((id) => Object.values(window.__deltas[id] ?? {}), sid);
    }
    for (const count of [1, 10]) {
      const home = join(fixture, `workspace-${count}`);
      mkdirSync(home);
      const repos = [];
      for (let i = 0; i < count; i++) {
        const repo = join(home, `group-${i % 3}`, `repo-${i}`);
        mkdirSync(repo, { recursive: true });
        const git = (...args) =>
          execFileSync('git', args, {
            cwd: repo,
            windowsHide: true,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          });
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        for (let file = 0; file < 20; file++)
          writeFileSync(join(repo, `${file}.txt`), 'original\n');
        git('add', '.');
        git('commit', '-qm', 'seed');
        for (let file = 0; file < 20; file++) writeFileSync(join(repo, `${file}.txt`), 'changed\n');
        repos.push(repo);
      }
      for (let i = 0; i < 200; i++)
        mkdirSync(join(home, `empty-${i}`, 'a', 'b'), { recursive: true });
      const opened = Date.now();
      const sid = await openSession(page, { path: slash(home) });
      await page.waitForFunction(
        ({ sid, count }) => window.__sessions.find((s) => s.id === sid)?.repos?.length === count,
        { sid, count },
        { timeout: 30000 },
      );
      log(`${count} nested repos discovered in ${Date.now() - opened} ms`);
      // The fill is pushed, so the window opens before Changes is shown and closes when the
      // snapshots (with their line counts) have arrived and the host has gone quiet.
      const filling = await mark();
      await openChangesTab(page);
      await awaitSnapshots(sid, { count }, 'all nested repositories returned');
      await awaitSnapshots(
        sid,
        { count, changes: 20, kind: 'M', added: 1, removed: 1, lines: true },
        'all modified files and line counts correct',
      );
      await pause(1500);
      const modified = await measure(`${count} repos x 20 modified`, filling);
      // Contract: one status per repo per read; the fill may read twice (names only, then again
      // once Changes asks for lines), and the lines read is one pair of numstat passes.
      assert(
        modified.statusRepos <= count && modified.statusPerRepoMax <= 2,
        `modified fill: at most 2 status per repo, none outside the ${count} repos (repos ${modified.statusRepos}, max ${modified.statusPerRepoMax})`,
      );
      assert(
        modified.numstatPerRepoMax <= 2,
        `modified fill: lines are read once per repo, two numstat passes (max ${modified.numstatPerRepoMax})`,
      );
      assert(modified.gitCalls <= count * 10, 'modified refresh has bounded Git work');
      assert(modified.peakGit <= 16, 'modified refresh does not fan out overlapping processes');
      await page.waitForFunction(
        (count) => document.querySelectorAll('.repo-head').length === count,
        count,
        { timeout: 10000 },
      );
      await pause(1000);
      const beforeIdle = await app.evaluate(() => globalThis.__nestedProbe.calls);
      await pause(2000);
      const idleCalls = (await app.evaluate(() => globalThis.__nestedProbe.calls)) - beforeIdle;
      log(`${count} repos idle Git commands over 2s: ${idleCalls}`);
      assert(idleCalls === 0, 'unchanged nested repos do not continuously poll Git');
      const deleting = await mark();
      for (const repo of repos)
        for (let file = 0; file < 20; file++) unlinkSync(join(repo, `${file}.txt`));
      await awaitSnapshots(
        sid,
        { count, changes: 20, kind: 'D', removed: 1, lines: true },
        'all deleted files and HEAD line counts correct',
      );
      await pause(1500);
      const deleted = await measure(`${count} repos x 20 deleted`, deleting);
      // Contract: a burst shorter than the cooldown costs one run, plus one trailing run when an
      // event of the burst (Windows reports the folder's own change late) lands after that run
      // started. Changes is shown, so each run counts lines: two numstat passes plus the one HEAD
      // deletion pass.
      assert(
        deleted.statusRepos <= count && deleted.statusPerRepoMax <= 2,
        `deleted burst: at most one run plus its trailing run per repo (repos ${deleted.statusRepos}, max ${deleted.statusPerRepoMax})`,
      );
      assert(
        deleted.numstatPerRepoMax <= 3 * deleted.statusPerRepoMax,
        `deleted burst: three numstat passes per run (max ${deleted.numstatPerRepoMax} for ${deleted.statusPerRepoMax} runs)`,
      );
      assert(deleted.gitCalls <= count * 16, 'deleted refresh has bounded Git work');
      assert(deleted.peakGit <= 16, 'deleted refresh does not fan out overlapping processes');
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sid);
      if (count === 10) {
        const git = (...args) =>
          execFileSync('git', args, {
            cwd: home,
            windowsHide: true,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          });
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        writeFileSync(join(home, '.gitignore'), 'group-*/\nempty-*/\n');
        for (let file = 0; file < 20; file++)
          writeFileSync(join(home, `parent-${file}.txt`), 'original\n');
        git('add', '.');
        git('commit', '-qm', 'parent seed');
        for (let file = 0; file < 20; file++)
          writeFileSync(join(home, `parent-${file}.txt`), 'changed\n');
        const parentStart = await mark();
        const parent = await openSession(page, { path: slash(home) });
        await page.waitForFunction(
          (sid) => window.__sessions.find((s) => s.id === sid)?.repos?.length === 1,
          parent,
          { timeout: 30000 },
        );
        await awaitSnapshots(parent, { count: 1 }, 'discovery stops at parent repository boundary');
        await measure('parent repository boundary', parentStart);
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), parent);
        const attachedStart = await mark();
        const attached = await openSession(page, {
          path: slash(home),
          roots: repos.slice(0, 9).map(slash),
        });
        await page.waitForFunction(
          (sid) => window.__sessions.find((s) => s.id === sid)?.repos?.length === 1,
          attached,
          { timeout: 30000 },
        );
        await awaitSnapshots(
          attached,
          { count: 1, changes: 20 },
          'overlapping roots preserve the parent repository boundary',
        );
        await measure('overlapping child roots rejected', attachedStart);
        assert(
          await page.evaluate(
            (sid) => window.__sessions.find((s) => s.id === sid)?.roots?.length === 0,
            attached,
          ),
          'overlapping attached folders are rejected',
        );
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), attached);
        const childStart = await mark();
        const child = await openSession(page, { path: slash(repos[0]) });
        await page.waitForFunction(
          (sid) => window.__sessions.find((s) => s.id === sid)?.repos?.length === 1,
          child,
          { timeout: 30000 },
        );
        await awaitSnapshots(
          child,
          { count: 1, changes: 20 },
          'a child repository in its own session returns its 20 changes',
        );
        await measure('repository inside parent in its own session', childStart);
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), child);
      }
    }
    if (process.env.CONDUIT_NESTED_METRICS)
      writeFileSync(process.env.CONDUIT_NESTED_METRICS, JSON.stringify(measurements, null, 2));
  } finally {
    await app.evaluate(() => clearInterval(globalThis.__nestedProbe?.timer)).catch(() => {});
    await closeApp(app, page);
    await app.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

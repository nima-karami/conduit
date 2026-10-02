import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openChangesTab, openSession, runScenario } from './harness.mjs';

runScenario('nested-repo-resources', async ({ app, page, log }) => {
  const fixture = mkdtempSync(join(tmpdir(), 'conduit-nested-resources-'));
  const slash = (p) => p.replace(/\\/g, '/');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const measurements = [];
  try {
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
    let requestId = 88000;
    async function refresh(home, sid, label) {
      const id = ++requestId;
      await app.evaluate(() => {
        const probe = globalThis.__nestedProbe;
        probe.calls = 0;
        probe.peak = probe.active;
        probe.gaps = [];
        probe.events = {};
        probe.cpu = process.cpuUsage();
      });
      const start = Date.now();
      await page.evaluate(
        ({ home, sid, id }) => {
          window.__nestedProject = undefined;
          const unsubscribe = window.agentDeck.subscribe((message) => {
            if (message.type === 'project' && message.requestId === id) {
              window.__nestedProject = message;
              unsubscribe();
            }
          });
          const session = window.__sessions.find((s) => s.id === sid);
          window.agentDeck.post({
            type: 'requestProject',
            path: home,
            sessionId: sid,
            changesRoot: session.activeRepoRoot,
            requestId: id,
          });
        },
        { home: slash(home), sid, id },
      );
      await page.waitForFunction(() => window.__nestedProject !== undefined, null, {
        timeout: 30000,
      });
      const project = await page.evaluate(() => window.__nestedProject);
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
      const measurement = { label, elapsedMs: Date.now() - start, ...metrics };
      measurements.push(measurement);
      log(JSON.stringify(measurement));
      return project;
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
      await openChangesTab(page);
      await pause(1500);
      const modified = await refresh(home, sid, `${count} repos x 20 modified`);
      assert(measurements.at(-1).gitCalls <= count * 10, 'modified refresh has bounded Git work');
      assert(
        measurements.at(-1).peakGit <= 16,
        'modified refresh does not fan out overlapping processes',
      );
      assert(modified.repoChanges?.length === count, 'all nested repositories returned');
      assert(
        modified.repoChanges.every(
          (repo) =>
            repo.changes.length === 20 &&
            repo.changes.every(
              (change) => change.kind === 'M' && change.added === 1 && change.removed === 1,
            ),
        ),
        'all modified files and line counts correct',
      );
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
      for (const repo of repos)
        for (let file = 0; file < 20; file++) unlinkSync(join(repo, `${file}.txt`));
      await pause(1500);
      const deleted = await refresh(home, sid, `${count} repos x 20 deleted`);
      assert(measurements.at(-1).gitCalls <= count * 16, 'deleted refresh has bounded Git work');
      assert(
        measurements.at(-1).peakGit <= 16,
        'deleted refresh does not fan out overlapping processes',
      );
      assert(
        deleted.repoChanges.every(
          (repo) =>
            repo.changes.length === 20 &&
            repo.changes.every((change) => change.kind === 'D' && change.removed === 1),
        ),
        'all deleted files and HEAD line counts correct',
      );
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
        const parent = await openSession(page, { path: slash(home) });
        await page.waitForFunction(
          (sid) => window.__sessions.find((s) => s.id === sid)?.repos?.length === 1,
          parent,
          { timeout: 30000 },
        );
        const parentOnly = await refresh(home, parent, 'parent repository boundary');
        assert(
          parentOnly.repoChanges?.length === 1,
          'discovery stops at parent repository boundary',
        );
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), parent);
        const attached = await openSession(page, {
          path: slash(home),
          roots: repos.slice(0, 9).map(slash),
        });
        await page.waitForFunction(
          (sid) => window.__sessions.find((s) => s.id === sid)?.repos?.length === 1,
          attached,
          { timeout: 30000 },
        );
        await pause(1500);
        const inside = await refresh(home, attached, 'overlapping child roots rejected');
        assert(
          inside.repoChanges?.length === 1 &&
            inside.repoChanges.every((repo) => repo.changes.length === 20),
          'overlapping roots preserve the parent repository boundary',
        );
        assert(
          await page.evaluate(
            (sid) => window.__sessions.find((s) => s.id === sid)?.roots?.length === 0,
            attached,
          ),
          'overlapping attached folders are rejected',
        );
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), attached);
        const child = await openSession(page, { path: slash(repos[0]) });
        await page.waitForFunction(
          (sid) => window.__sessions.find((s) => s.id === sid)?.repos?.length === 1,
          child,
          { timeout: 30000 },
        );
        const childProject = await refresh(
          repos[0],
          child,
          'repository inside parent in its own session',
        );
        assert(
          childProject.repoChanges?.length === 1 &&
            childProject.repoChanges[0].changes.length === 20,
          'a child repository in its own session returns its 20 changes',
        );
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

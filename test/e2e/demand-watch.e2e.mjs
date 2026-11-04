import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from './attention-footer-helpers.mjs';
import {
  assert,
  openChangesTab,
  openSession,
  revealSessionRow,
  runScenario,
  showRightView,
  typeLine,
} from './harness.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const fixtureRoot = mkdtempSync(join(tmpdir(), 'conduit-demand-watch-'));
process.once('exit', () => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Best-effort cleanup.
  }
});

function initRepo(name) {
  const root = join(fixtureRoot, name);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  writeFileSync(join(root, '.keep'), '');
  rmSync(join(root, '.keep'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  return root.replace(/\\/g, '/');
}

const repoA = initRepo('repo-a');
const repoB = initRepo('repo-b');
const repoC = initRepo('repo-c');

runScenario('demand-watch', async ({ app, page, log }) => {
  await app.evaluate(
    (_electron, repos) => {
      const fs = process.getBuiltinModule('fs');
      const cp = process.getBuiltinModule('child_process');
      const watch = fs.watch;
      const exec = cp.execFile;
      const key = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const roots = repos.map((r) => key(r));
      const state = {
        handlesByRepo: Object.fromEntries(roots.map((r) => [r, 0])),
        openWatchCallsByRepo: Object.fromEntries(roots.map((r) => [r, 0])),
        gitCallsByRepo: Object.fromEntries(roots.map((r) => [r, []])),
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
          state.openWatchCallsByRepo[repo] += 1;
          watcher.once('close', () => {
            state.handlesByRepo[repo] = Math.max(0, state.handlesByRepo[repo] - 1);
          });
        }
        return watcher;
      };
      cp.execFile = function (bin, args, options, ...rest) {
        if (/(^|[\\/])git(\.exe)?$/i.test(String(bin))) {
          const repo = owner(options?.cwd ?? '');
          if (repo) {
            const list = Array.isArray(args) ? args.map(String) : [];
            state.gitCallsByRepo[repo].push({ at: Date.now(), sub: list[0] ?? '', args: list });
          }
        }
        return exec.call(this, bin, args, options, ...rest);
      };
      globalThis.__demandWatch = state;
    },
    [repoA, repoB, repoC],
  );

  await page.evaluate(() => {
    if (window.__demandWatchTap) return;
    window.__demandWatchTap = true;
    window.__demandWatchFs = [];
    window.__demandWatchDelta = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'fsChanged') window.__demandWatchFs.push(m);
      if (m.type === 'repoDelta') window.__demandWatchDelta.push(m);
    });
  });

  const sidA = await openSession(page, { path: repoA, agentId: 'shell:cmd' });
  const sidB = await openSession(page, { path: repoB, agentId: 'shell:cmd' });
  const sidC = await openSession(page, { path: repoC, agentId: 'shell:cmd' });

  const handles = (repo) =>
    app.evaluate((r) => globalThis.__demandWatch.handlesByRepo[r], norm(repo));
  const watchOpens = (repo) =>
    app.evaluate((r) => globalThis.__demandWatch.openWatchCallsByRepo[r], norm(repo));
  const gitCalls = (repo) =>
    app.evaluate((r) => globalThis.__demandWatch.gitCallsByRepo[r] ?? [], norm(repo));
  const resetCounters = () =>
    app.evaluate(() => {
      for (const k of Object.keys(globalThis.__demandWatch.gitCallsByRepo))
        globalThis.__demandWatch.gitCallsByRepo[k] = [];
    });
  const activate = async (sid) => {
    await revealSessionRow(page, sid);
    await page.locator(`[data-agent-tree] .session[data-sessionid="${sid}"]`).click();
    await page.waitForFunction(
      (id) => document.querySelector('.session--active')?.getAttribute('data-sessionid') === id,
      sid,
      { timeout: 10000 },
    );
  };

  await activate(sidA);
  await wait(1000);
  assert((await handles(repoB)) === 0, 'AC-1: hidden repo B holds no watch');
  assert((await handles(repoC)) === 0, 'AC-1: hidden repo C holds no watch');
  assert((await handles(repoA)) >= 1, 'shown repo A is watched');

  await resetCounters();
  writeFileSync(join(repoB, 'seed.txt'), `seed-${Date.now()}\n`);
  writeFileSync(join(repoB, 'b-one.txt'), 'one\n');
  writeFileSync(join(repoB, 'b-two.txt'), 'two\n');
  await wait(2000);
  assert((await gitCalls(repoB)).length === 0, 'AC-2/3: hidden writes run no git for B');

  const beforeCompletions = await page.evaluate(
    (sid) => (window.__sessions || []).find((s) => s.id === sid)?.completions ?? 0,
    sidB,
  );
  await report(page, sidB, 'working');
  await report(page, sidB, 'done');
  await page.waitForFunction(
    ({ sid, base }) =>
      ((window.__sessions || []).find((s) => s.id === sid)?.completions ?? 0) > base,
    { sid: sidB, base: beforeCompletions },
    { timeout: 10000 },
  );
  await page.waitForFunction(
    ({ repo }) => {
      const calls = globalThis.__demandWatch?.gitCallsByRepo?.[repo] ?? [];
      return calls.filter((c) => c.sub === 'status').length === 1;
    },
    { repo: norm(repoB) },
    { timeout: 3000 },
  );
  assert(
    (await handles(repoB)) === 0,
    'AC-1: B still holds no watch after hidden turn-end refresh',
  );
  const bStateOk = await page.evaluate(
    ({ sid, root }) => {
      const normalize = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const s = (window.__sessions || []).find((x) => x.id === sid);
      if (!s?.repoGit) return false;
      const byRoot = Object.entries(s.repoGit).find(([k]) => normalize(k) === root)?.[1];
      return !!(byRoot && byRoot.kind === 'branch' && byRoot.branch && byRoot.dirty === true);
    },
    { sid: sidB, root: norm(repoB) },
  );
  assert(bStateOk, 'AC-4: hidden turn-end refresh updates B branch + dirty in session state');

  for (let i = 0; i < 10; i++) await typeLine(page, sidC, `echo c-${i}`);
  await wait(3000);
  assert((await gitCalls(repoC)).length === 0, 'AC-13: hidden plain-shell commands run no git');

  writeFileSync(join(repoB, 'late.txt'), `late-${Date.now()}\n`);
  await activate(sidB);
  await openChangesTab(page);
  await page.waitForFunction(
    ({ sid, root }) =>
      (window.__demandWatchDelta || []).some((d) => {
        const snap = d.sessionId === sid ? d.repos?.[root] : undefined;
        return !!(d.full && snap && snap.stale === true);
      }),
    { sid: sidB, root: repoB },
    { timeout: 10000 },
  );
  assert(
    (await page.locator('.repo-head__stale').count()) > 0,
    'AC-5: stale badge appears on show',
  );
  await page.waitForFunction(
    ({ sid, root }) =>
      (window.__demandWatchDelta || []).some((d) => {
        if (d.sessionId !== sid) return false;
        const snap = d.repos?.[root];
        if (!snap || snap.stale === true) return false;
        return (snap.changes ?? []).some((c) => String(c.path).includes('late.txt'));
      }),
    { sid: sidB, root: repoB },
    { timeout: 1500 },
  );
  await page.waitForFunction(
    () => (document.querySelectorAll('.repo-head__stale') || []).length === 0,
    null,
    {
      timeout: 5000,
    },
  );
  const fsChangedForB = await page.evaluate(
    (root) =>
      (window.__demandWatchFs || []).some((m) =>
        (m.folders || []).some((f) => norm(f) === norm(root)),
      ),
    repoB,
  );
  assert(fsChangedForB, 'AC-5: show emits fsChanged for B roots');

  await activate(sidA);
  const minimized = await app.evaluate((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    win.minimize();
    if (!win.isMinimized()) {
      win.show();
      win.minimize();
    }
    return win.isMinimized();
  });
  assert(minimized === true, 'window minimized');
  await page.waitForFunction(
    ({ repo }) => (globalThis.__demandWatch?.handlesByRepo?.[repo] ?? 0) === 0,
    { repo: norm(repoA) },
    { timeout: 1000 },
  );
  const fsBefore = await page.evaluate(() => window.__demandWatchFs.length);
  await resetCounters();
  writeFileSync(join(repoA, 'while-min.txt'), `min-${Date.now()}\n`);
  await wait(2000);
  assert((await gitCalls(repoA)).length === 0, 'AC-6: minimized window suppresses git for A');
  const fsAfter = await page.evaluate(() => window.__demandWatchFs.length);
  assert(fsAfter === fsBefore, 'AC-6: minimized window emits no fsChanged for A');
  const opensBeforeRestore = await watchOpens(repoA);
  await app.evaluate((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    win.restore();
    win.hide();
  });
  await page.waitForFunction(
    ({ repo, before }) => (globalThis.__demandWatch?.openWatchCallsByRepo?.[repo] ?? 0) > before,
    { repo: norm(repoA), before: opensBeforeRestore },
    { timeout: 2000 },
  );
  await page.waitForFunction(
    ({ repo }) => (globalThis.__demandWatch?.gitCallsByRepo?.[repo] ?? []).length >= 1,
    { repo: norm(repoA) },
    { timeout: 2000 },
  );
  await showRightView(page, 'files');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.filerow__name')].some((el) =>
        String(el.textContent ?? '').includes('while-min.txt'),
      ),
    null,
    { timeout: 10000 },
  );

  await activate(sidA);
  const bOpensBeforeDelete = await watchOpens(repoB);
  rmSync(repoB, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await wait(2000);
  assert((await handles(repoB)) === 0, 'AC-8: deleted hidden B has no live watch');
  assert((await watchOpens(repoB)) === bOpensBeforeDelete, 'AC-8: delete does not reopen B watch');

  log('AC-1..6,8,13 demand-watch scenario authored');
});

/**
 * Shared repo tracking (docs/plans/2026-10-16-multi-repo-tracking.plan.md Task 2.8): ONE git
 * status per dirty repo per burst, fanned out to every session containing it, and a renderer
 * that comes back (card click, reload) is filled from the host's cache without git.
 *
 * Layout: <ws> is not a repo and holds repoA, repoB and <ws>/ticket/repoA-wt (a linked worktree
 * of repoA). The ticket session (home = ticket) is opened first and stays in the background; the
 * parent session (home = ws) is opened last, so it is the active one with Changes shown. Both
 * contain the worktree, so a single status of it must reach both.
 *
 * Hidden sessions hold no watches and run no git (spec 2026-11-03-demand-driven-resources):
 * while the parent is hidden only the shown worktree's common dir (repoA/.git) is watched, and
 * switching back runs exactly one catch-up status per repo that was unshown (D8) — the worktree,
 * shown throughout via the ticket, runs none. After a renderer reload the shown session's repos catch up once.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGitProbe, readGitProbe, resetGitProbe, statusCalls } from './git-probe.mjs';
import {
  assert,
  openChangesTab,
  openSession,
  removeDir,
  runScenario,
  shutdownApp,
} from './harness.mjs';

const WRITE_WINDOW_MS = 3000;
const CARD_RENDER_MS = 1000;
const RELOAD_RENDER_MS = 3000;
/** Long enough for any catch-up run (settle + cooldown) a switch back would start. */
const SWITCH_BACK_WINDOW_MS = 3000;
const FILE = 'agent-1.txt';

const slash = (p) => p.replace(/\\/g, '/');
const key = (p) => slash(p).replace(/\/+$/, '').toLowerCase();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
}

/** page.waitForFunction that fails as an assertion, naming what the page actually held. */
async function waitOrFail(page, fn, arg, timeout, what, observe) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    const seen = await page.evaluate(observe, arg);
    assert(false, `${what} (observed ${JSON.stringify(seen)})`);
  }
}

/** The change rows currently drawn in the right pane, by file name. */
const shownFiles = () =>
  Array.from(document.querySelectorAll('.change__file'), (el) => el.textContent);

/** Counts the main process's open fs.watch handles inside each given repo's `.git`. */
async function installGitDirWatchProbe(app, repos) {
  await app.evaluate((_electron, dirs) => {
    const fs = process.getBuiltinModule('fs');
    const watch = fs.watch;
    const key = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const open = Object.fromEntries(dirs.map((d) => [key(d), 0]));
    globalThis.__gitDirWatches = open;
    fs.watch = function (file, ...args) {
      const watcher = watch.call(this, file, ...args);
      const k = key(file);
      // Linux serves a recursive watch as per-directory non-recursive children: count the caller's.
      const recursive = args[0]?.recursive === true;
      const repo = Object.keys(open).find((d) => k === `${d}/.git` || k.startsWith(`${d}/.git/`));
      if (repo && (process.platform !== 'linux' || recursive)) {
        open[repo]++;
        watcher.once('close', () => open[repo]--);
      }
      return watcher;
    };
  }, repos);
}

/** Block until the host has spawned no git for `quietMs`, so a probe reset starts from silence. */
async function gitQuiet(app, quietMs, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const calls = await readGitProbe(app);
    const last = calls.at(-1)?.at ?? 0;
    if (Date.now() - last >= quietMs) return;
    assert(Date.now() < deadline, `git never went quiet for ${quietMs} ms (${calls.length} calls)`);
    await pause(100);
  }
}

runScenario('repo-tracker-fanout', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-fanout-')));
  const ws = join(root, 'ws');
  const repoA = join(ws, 'repoA');
  const repoB = join(ws, 'repoB');
  const ticket = join(ws, 'ticket');
  const wt = join(ticket, 'repoA-wt');
  try {
    initRepo(repoA);
    initRepo(repoB);
    mkdirSync(ticket);
    git(repoA, 'worktree', 'add', '-q', '-b', 'ticket-1', wt);

    await installGitProbe(app);
    await installGitDirWatchProbe(app, [repoA, repoB]);
    const ticketId = await openSession(page, { path: slash(ticket) });
    const parentId = await openSession(page, { path: slash(ws) });
    await openChangesTab(page);

    // First fill: every repo interrogated for both sessions, and the Changes heads past "Loading…".
    const filled = ({ parentId: p, ticketId: t }) => {
      const byId = (id) => (window.__sessions || []).find((s) => s.id === id);
      const gitKeys = (s) => Object.keys(s?.repoGit ?? {}).length;
      const heads = document.querySelectorAll('.repo-head').length;
      const loading = Array.from(
        document.querySelectorAll('.repo-head__empty, .changes__header-count'),
        (el) => el.textContent,
      ).includes('Loading…');
      return (
        (byId(p)?.repos?.length ?? 0) === 3 &&
        gitKeys(byId(p)) >= 3 &&
        gitKeys(byId(t)) >= 1 &&
        heads === 3 &&
        !loading
      );
    };
    await waitOrFail(
      page,
      filled,
      { parentId, ticketId },
      30000,
      'first fill did not complete',
      ({ parentId: p, ticketId: t }) => ({
        parentRepos: (window.__sessions || []).find((s) => s.id === p)?.repos?.length,
        parentGit: Object.keys((window.__sessions || []).find((s) => s.id === p)?.repoGit ?? {}),
        ticketGit: Object.keys((window.__sessions || []).find((s) => s.id === t)?.repoGit ?? {}),
        heads: document.querySelectorAll('.repo-head').length,
      }),
    );
    log('first fill complete');

    // The fill's trailing runs must not be counted against the burst under test.
    await gitQuiet(app, 1500, 20000);
    await resetGitProbe(app);

    writeFileSync(join(wt, FILE), 'one\n');
    const wroteAt = Date.now();
    await waitOrFail(
      page,
      (name) =>
        Array.from(document.querySelectorAll('.change__file')).some((e) => e.textContent === name),
      FILE,
      WRITE_WINDOW_MS,
      `the parent's Changes list never showed ${FILE} written in the worktree`,
      shownFiles,
    );
    log(`parent list shows ${FILE} ${Date.now() - wroteAt} ms after the write`);
    await pause(Math.max(0, wroteAt + WRITE_WINDOW_MS - Date.now()));

    const statuses = statusCalls(await readGitProbe(app));
    const cwds = statuses.map((c) => c.cwd);
    const at = (dir) => statuses.filter((c) => c.cwd === key(dir)).length;
    assert(
      at(wt) === 1,
      `one write in the worktree = exactly 1 status of it within ${WRITE_WINDOW_MS} ms (got ${at(wt)}; status cwds ${JSON.stringify(cwds)})`,
    );
    assert(
      at(repoA) === 0 && at(repoB) === 0,
      `no status of repoA/repoB for a worktree write (repoA ${at(repoA)}, repoB ${at(repoB)}; status cwds ${JSON.stringify(cwds)})`,
    );
    log('one write → 1 status of the worktree, 0 of repoA/repoB, shown in the parent');

    // Card click: the ticket session's list renders from the cache.
    const statusBeforeClick = statuses.length;
    await page.click(`.session[data-sessionid="${ticketId}"] .session__name`);
    await waitOrFail(
      page,
      (name) =>
        document.querySelectorAll('.repo-head').length === 1 &&
        Array.from(document.querySelectorAll('.change__file')).some((e) => e.textContent === name),
      FILE,
      CARD_RENDER_MS,
      `the ticket card's Changes list did not show ${FILE} within ${CARD_RENDER_MS} ms`,
      () => ({
        heads: document.querySelectorAll('.repo-head').length,
        files: Array.from(document.querySelectorAll('.change__file'), (el) => el.textContent),
      }),
    );
    const afterClick = statusCalls(await readGitProbe(app));
    assert(
      afterClick.length === statusBeforeClick,
      `clicking the ticket card ran git status (${afterClick.length - statusBeforeClick} new: ${JSON.stringify(afterClick.slice(statusBeforeClick).map((c) => c.cwd))})`,
    );
    log('ticket card → list from cache, 0 new status');

    const ownWatches = await app.evaluate(() => globalThis.__gitDirWatches);
    const watchesOf = (dir) => Object.entries(ownWatches).find(([k]) => k === key(dir))?.[1] ?? 0;
    // repoA/.git is the shown worktree's common dir, so the ticket needs it; repoB is hidden-only.
    assert(
      watchesOf(repoB) === 0 && watchesOf(repoA) === 1,
      `with the parent hidden: hidden-only repoB must have no git-dir watch and the shown worktree's common dir (repoA/.git) exactly one (${JSON.stringify(ownWatches)})`,
    );
    log(
      'parent hidden → no git-dir watch for hidden-only repoB; repoA only as the worktree common dir',
    );

    // Back to the parent with nothing written meanwhile: its list renders from the cache, current.
    const fixture = new Set([wt, repoA, repoB].map(key));
    const statusBeforeBack = statusCalls(await readGitProbe(app)).length;
    await page.click(`.session[data-sessionid="${parentId}"] .session__name`);
    await waitOrFail(
      page,
      (name) =>
        document.querySelectorAll('.repo-head').length === 3 &&
        Array.from(document.querySelectorAll('.change__file')).some((e) => e.textContent === name),
      FILE,
      CARD_RENDER_MS,
      `switching back to the parent did not show its list within ${CARD_RENDER_MS} ms`,
      () => ({
        heads: document.querySelectorAll('.repo-head').length,
        files: Array.from(document.querySelectorAll('.change__file'), (el) => el.textContent),
      }),
    );
    const staleNotices = await page.evaluate(
      () => document.querySelectorAll('.repo-head__stale').length,
    );
    await pause(SWITCH_BACK_WINDOW_MS);
    const back = statusCalls(await readGitProbe(app))
      .slice(statusBeforeBack)
      .filter((c) => fixture.has(c.cwd));
    const backAt = (dir) => back.filter((c) => c.cwd === key(dir)).length;
    assert(
      // One catch-up per unshown repo (D8); a second status is the lines upgrade when the catch-up
      // starts before the parent's changes:subscribe lands (repo-tracker linesDemandChanged).
      [backAt(repoA), backAt(repoB)].every((n) => n >= 1 && n <= 2) && backAt(wt) === 0,
      `switching back must catch up once per unshown repo and not the shown worktree (repoA ${backAt(repoA)}, repoB ${backAt(repoB)}, worktree ${backAt(wt)})`,
    );
    log(
      `ticket → parent → list from cache, then one catch-up each for repoA/repoB (${staleNotices} stale notices while it ran)`,
    );

    assert(
      (await page.evaluate(() => document.querySelectorAll('.repo-head__stale').length)) === 0,
      'a repo was still marked stale after the switch-back catch-up window',
    );
    const statusBeforeReload = statusCalls(await readGitProbe(app)).length;
    // A reloaded renderer activates the first session in the list, so the ticket goes first: the
    // same session comes back on screen and only the host's cache can refill its list.
    await page.evaluate(
      (order) => window.agentDeck.post({ type: 'reorderSessions', order }),
      [ticketId, parentId],
    );
    await page.waitForFunction((id) => window.__sessions?.[0]?.id === id, ticketId, {
      timeout: 10000,
    });
    // Reload takes the render-process-gone recovery path (same window id, `visible` re-posted).
    await page.reload();
    await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
    await openChangesTab(page);
    await waitOrFail(
      page,
      (name) =>
        Array.from(document.querySelectorAll('.change__file')).some((e) => e.textContent === name),
      FILE,
      RELOAD_RENDER_MS,
      `after a renderer reload the Changes list did not show ${FILE} within ${RELOAD_RENDER_MS} ms`,
      shownFiles,
    );
    // The list above rendered from the host's cache. The reloaded renderer first reports nothing
    // visible, so every fixture repo goes unshown; whichever session comes back on screen catches
    // up its repos once each (D8, plus the possible lines upgrade) and the hidden one's run nothing.
    const activeAfterReload = await page.evaluate(
      () => document.querySelector('.session--active')?.getAttribute('data-sessionid') ?? null,
    );
    assert(
      activeAfterReload === ticketId || activeAfterReload === parentId,
      `after a reload no fixture session is active (${activeAfterReload})`,
    );
    const shownRepos = activeAfterReload === parentId ? [wt, repoA, repoB] : [wt];
    await pause(SWITCH_BACK_WINDOW_MS);
    const afterReload = statusCalls(await readGitProbe(app))
      .slice(statusBeforeReload)
      .filter((c) => fixture.has(c.cwd));
    const reloadAt = (dir) => afterReload.filter((c) => c.cwd === key(dir)).length;
    assert(
      [wt, repoA, repoB].every((dir) => {
        const n = reloadAt(dir);
        return shownRepos.includes(dir) ? n >= 1 && n <= 2 : n === 0;
      }),
      `after a reload with ${activeAfterReload === parentId ? 'the parent' : 'the ticket'} shown: its repos catch up 1–2, others 0 (worktree ${reloadAt(wt)}, repoA ${reloadAt(repoA)}, repoB ${reloadAt(repoB)})`,
    );
    assert(
      (await page.evaluate(() => document.querySelectorAll('.repo-head__stale').length)) === 0,
      'a repo was still marked stale after the reload catch-up window',
    );
    log(
      `reload → list restored from cache, then one catch-up per repo of the shown ${activeAfterReload === parentId ? 'parent' : 'ticket'}`,
    );
  } finally {
    // shutdownApp, not closeApp: a quit leaves the agents running in the fixture (F4), and their
    // cwd pins it against the delete below.
    await shutdownApp(app, page);
    await removeDir(root);
  }
});

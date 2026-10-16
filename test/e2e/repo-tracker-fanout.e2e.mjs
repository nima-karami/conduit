/**
 * Shared repo tracking (docs/plans/2026-10-16-multi-repo-tracking.plan.md Task 2.8): ONE git
 * status per dirty repo per burst, fanned out to every session containing it, and a renderer
 * that comes back (card click, reload) is filled from the host's cache without git.
 *
 * Layout: <ws> is not a repo and holds repoA, repoB and <ws>/ticket/repoA-wt (a linked worktree
 * of repoA). The ticket session (home = ticket) is opened first and stays in the background; the
 * parent session (home = ws) is opened last, so it is the active one with Changes shown. Both
 * contain the worktree, so a single status of it must reach both.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGitProbe, readGitProbe, resetGitProbe, statusCalls } from './git-probe.mjs';
import {
  assert,
  closeApp,
  openChangesTab,
  openSession,
  removeDir,
  runScenario,
} from './harness.mjs';

const WRITE_WINDOW_MS = 3000;
const CARD_RENDER_MS = 1000;
const RELOAD_RENDER_MS = 3000;
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
    // Only the fixture's repos count: the profile's other sessions may become visible after the
    // reload and get their own first read.
    const fixture = new Set([wt, repoA, repoB].map(key));
    const afterReload = statusCalls(await readGitProbe(app))
      .slice(statusBeforeClick)
      .filter((c) => fixture.has(c.cwd));
    assert(
      afterReload.length === 0,
      `a renderer reload ran git status of the fixture repos (${afterReload.length} new: ${JSON.stringify(afterReload.map((c) => c.cwd))})`,
    );
    log('reload → list restored from cache, 0 new status');
  } finally {
    await closeApp(app, page);
    await removeDir(root);
  }
});

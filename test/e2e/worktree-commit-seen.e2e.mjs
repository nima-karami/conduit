/**
 * A commit and a branch switch made in a linked worktree are seen with no UI action even when the
 * worktree's main repo lies OUTSIDE the session home (docs/plans/2026-10-16-multi-repo-tracking.plan.md
 * Task 2.8). The home's watcher never covers the main repo's git dir, so the tracker has to watch
 * that dir itself.
 *
 * Layout: <root>/main (repo, outside home) and <root>/ticket (home, not a repo) holding
 * <root>/ticket/main-wt, a linked worktree of main on branch `feat`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  openChangesTab,
  openSession,
  removeDir,
  runScenario,
} from './harness.mjs';

const SEEN_MS = 3000;
const FILE = 'new.txt';

const slash = (p) => p.replace(/\\/g, '/');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

/** page.waitForFunction that fails as an assertion, naming what the page actually held. */
async function waitOrFail(page, fn, arg, timeout, what) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    const seen = await page.evaluate(() => ({
      files: Array.from(document.querySelectorAll('.change__file'), (el) => el.textContent),
      labels: Array.from(document.querySelectorAll('.branch-chip__label'), (el) => el.textContent),
      empty: Array.from(document.querySelectorAll('.repo-head__empty'), (el) => el.textContent),
    }));
    assert(false, `${what} (observed ${JSON.stringify(seen)})`);
  }
}

runScenario('worktree-commit-seen', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-wt-seen-')));
  const main = join(root, 'main');
  const ticket = join(root, 'ticket');
  const wt = join(ticket, 'main-wt');
  try {
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 'test@example.com');
    git(main, 'config', 'user.name', 'Test');
    git(main, 'config', 'core.autocrlf', 'false');
    git(main, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(main, 'seed.txt'), 'seed\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-qm', 'seed');
    mkdirSync(ticket);
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    writeFileSync(join(wt, FILE), 'one\n');

    const sid = await openSession(page, { path: slash(ticket) });
    await page.waitForFunction(
      (id) => ((window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0) === 1,
      sid,
      { timeout: 20000 },
    );
    await openChangesTab(page);
    const listsOnly = ({ file, branch }) => {
      const labels = document.querySelectorAll('.repo-head .branch-chip__label');
      return (
        document.querySelectorAll('.change').length === 1 &&
        document.querySelector('.change__file')?.textContent === file &&
        labels[labels.length - 1]?.textContent === branch
      );
    };
    // The branch chip's last label is the branch; a worktree name, when shown, is the first.
    const onBranch = (branch) => {
      const labels = document.querySelectorAll('.repo-head .branch-chip__label');
      return labels[labels.length - 1]?.textContent === branch;
    };
    await waitOrFail(
      page,
      listsOnly,
      { file: FILE, branch: 'feat' },
      20000,
      `Changes never listed the one untracked ${FILE} on branch feat`,
    );
    log(`Changes lists ${FILE} on feat`);

    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'add new.txt');
    const committedAt = Date.now();
    await waitOrFail(
      page,
      () => document.querySelectorAll('.change').length === 0,
      null,
      SEEN_MS,
      `the list did not clear within ${SEEN_MS} ms of a commit in the worktree`,
    );
    log(`commit seen after ${Date.now() - committedAt} ms, no UI action`);

    git(wt, 'checkout', '-q', '-b', 'x');
    const switchedAt = Date.now();
    await waitOrFail(
      page,
      onBranch,
      'x',
      SEEN_MS,
      `the branch chip did not become x within ${SEEN_MS} ms of checkout -b x in the worktree`,
    );
    log(`branch switch seen after ${Date.now() - switchedAt} ms, no UI action`);
  } finally {
    await closeApp(app, page);
    await removeDir(root);
  }
});

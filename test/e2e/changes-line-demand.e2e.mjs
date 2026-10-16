/**
 * Line counts are read on demand (docs/plans/2026-10-16-multi-repo-tracking.plan.md Task 2.8):
 * while the Changes tab is hidden the host runs only `git status`, and `git diff --numstat`
 * starts when the tab is shown. An untracked file's `+3` therefore appears on show, not before.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installGitProbe,
  numstatCalls,
  readGitProbe,
  resetGitProbe,
  statusCalls,
} from './git-probe.mjs';
import {
  assert,
  closeApp,
  openChangesTab,
  openSession,
  removeDir,
  runScenario,
  waitForRepoGit,
} from './harness.mjs';

const QUIET_WINDOW_MS = 3000;
const LINES_MS = 3000;
const FILE = 'three.txt';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

/** Show the right pane's Files tab (expanding the pane if collapsed). */
async function openFilesTab(page) {
  if (!(await page.isVisible('.rightpane'))) {
    await page.keyboard.press('Control+Shift+E');
    await page.waitForSelector('.rightpane', { state: 'visible', timeout: 8000 });
  }
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Files'))
      ?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('.rtab--active')?.textContent?.trim().startsWith('Files'),
    null,
    { timeout: 15000 },
  );
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

runScenario('changes-line-demand', async ({ app, page, log }) => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-line-demand-')));
  try {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'seed');

    await installGitProbe(app);
    await openSession(page, { path: repo.replace(/\\/g, '/') });
    await waitForRepoGit(page);
    await openFilesTab(page);
    await gitQuiet(app, 1500, 20000);
    await resetGitProbe(app);

    writeFileSync(join(repo, FILE), 'a\nb\nc\n');
    await pause(QUIET_WINDOW_MS);
    const hidden = await readGitProbe(app);
    assert(
      statusCalls(hidden).length >= 1,
      `status never ran for the untracked file (git calls: ${JSON.stringify(hidden.map((c) => c.args))})`,
    );
    assert(
      numstatCalls(hidden).length === 0,
      `numstat ran with the Files tab shown: ${JSON.stringify(numstatCalls(hidden).map((c) => [c.cwd, c.args]))}`,
    );
    log(`Files tab: ${statusCalls(hidden).length} status, 0 numstat over ${QUIET_WINDOW_MS} ms`);

    await openChangesTab(page);
    try {
      await page.waitForFunction(
        (name) =>
          Array.from(document.querySelectorAll('.change')).some(
            (row) =>
              row.querySelector('.change__file')?.textContent === name &&
              row.querySelector('.diffstat--add')?.textContent === '+3',
          ),
        FILE,
        { timeout: LINES_MS },
      );
    } catch (e) {
      if (e?.name !== 'TimeoutError') throw e;
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.change'), (row) => row.textContent),
      );
      assert(
        false,
        `the ${FILE} row never showed +3 within ${LINES_MS} ms (rows ${JSON.stringify(rows)})`,
      );
    }
    const shown = await readGitProbe(app);
    assert(
      numstatCalls(shown).length > 0,
      'the +3 appeared but no numstat ran after the Changes tab opened',
    );
    log('Changes tab: +3 shown, numstat ran on demand');
  } finally {
    await closeApp(app, page);
    await removeDir(repo);
  }
});

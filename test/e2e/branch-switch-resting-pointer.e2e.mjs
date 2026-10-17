/**
 * Branch switcher under a resting pointer (path-links review r2): a filter keystroke re-lists
 * the rows under a pointer that does not move, and Enter must still switch to the top match, not
 * to whichever branch slid under the cursor.
 *
 * Drives the real hidden app on a throwaway repo (main + feat-alpha + feat-beta + fix-gamma):
 * opens the repo head's branch chip, moves the pointer onto the second row, types "feat" so
 * feat-beta lands under it, settles the pointer in place, presses Enter, and checks the repo's
 * on-disk HEAD is feat-alpha.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  finishScenario,
  launchApp,
  makeLog,
  openChangesTab,
  openSession,
  tapBridge,
} from './harness.mjs';

const NAME = 'branch-switch-resting-pointer';

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only`);
  await finishScenario(0);
}

const log = makeLog(NAME);
const tmps = [];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function mkRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-brrest-'));
  tmps.push(root);
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  for (const b of ['feat-alpha', 'feat-beta', 'fix-gamma']) git(root, ['branch', b]);
  return root;
}

const cleanTmps = () => {
  for (const p of tmps) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort: the OS reaps temp */
    }
  }
};

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);

  const repo = mkRepo().replace(/\\/g, '/');
  const sid = await openSession(page, { path: repo });
  await openChangesTab(page);
  await page.waitForFunction(
    () => document.querySelector('.repo-head .branch-chip')?.disabled === false,
    null,
    { timeout: 10000 },
  );
  // The switch is refused while the shell's startup output keeps the session busy.
  await page.waitForFunction(
    (id) => !(window.__sessions || []).find((s) => s.id === id)?.busy,
    sid,
    { timeout: 15000 },
  );
  await page.locator('.repo-head .branch-chip').click();
  const rows = page.locator('.branch-chip-menu .git-branch-menu__row');
  await page.waitForFunction(
    () => document.querySelectorAll('.branch-chip-menu .git-branch-menu__row').length === 4,
    null,
    { timeout: 8000 },
  );
  const labels = (await rows.allTextContents()).map((t) => t.trim());
  log('rows:', JSON.stringify(labels));
  assert(
    JSON.stringify(labels) === JSON.stringify(['main', 'feat-alpha', 'feat-beta', 'fix-gamma']),
    `expected the current branch first, then the rest, got ${JSON.stringify(labels)}`,
  );

  // The second row's centre is where feat-beta lands once "feat" filters main out.
  const box = await rows.nth(1).boundingBox();
  assert(box, 'the second row should have a box');
  const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  await page.mouse.move(at.x - 30, at.y, { steps: 1 });
  await page.mouse.move(at.x, at.y, { steps: 4 });

  await page.keyboard.type('feat');
  await page.waitForFunction(
    () => document.querySelectorAll('.branch-chip-menu .git-branch-menu__row').length === 2,
    null,
    { timeout: 5000 },
  );
  // Chromium sends the stationary pointer a same-point move after layout on its own schedule;
  // sending one here makes the row under it see exactly that, without moving.
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(600);

  const state = await page.evaluate(({ x, y }) => {
    const list = Array.from(document.querySelectorAll('.branch-chip-menu .git-branch-menu__row'));
    const under = document.elementFromPoint(x, y)?.closest('.git-branch-menu__row');
    return {
      labels: list.map((el) => el.textContent?.trim()),
      underIdx: under ? list.indexOf(under) : -1,
      underHovered: !!under?.matches(':hover'),
      activeIdx: list.findIndex((el) => el.classList.contains('ctxmenu__item--active')),
      pointer: document.querySelector('.git-branch-menu')?.getAttribute('data-pointer') ?? null,
    };
  }, at);
  log('after filter:', JSON.stringify(state));
  assert(
    state.underIdx >= 1 && state.underHovered,
    `precondition: the resting pointer should hover a row below the top match, got ${JSON.stringify(state)}`,
  );
  assert(
    state.activeIdx === 0 && state.labels[0] === 'feat-alpha',
    `the top match should stay active under a resting pointer, got ${JSON.stringify(state)}`,
  );

  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('.repo-head .branch-chip .branch-chip__ref-label')?.textContent !==
      'main',
    null,
    { timeout: 8000 },
  );
  const head = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(head === 'feat-alpha', `Enter should switch to the top match feat-alpha, got ${head}`);
  log('PASS ✓ Enter switched to the top match under a resting pointer');

  await launched.cleanup();
  cleanTmps();
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log(`[${NAME}] FAIL ✗`, e.message);
  else console.error(`[${NAME}] ERROR:`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* the scenario already failed; cleanup is best-effort */
  }
  cleanTmps();
  await finishScenario(isAssertion ? 1 : 2);
}

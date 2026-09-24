/**
 * Git branch/worktree state in the repo head's branch chip (FULL, runtime-observable).
 *
 * Drives the REAL hidden Electron app: seeds throwaway git repos in the OS temp dir,
 * opens each as a session cwd, and asserts both the host-pushed state
 * (`window.__sessions[sid].repoGit[root]`) AND the rendered chip (`.branch-chip*` in the Changes
 * tab). Crosses the host/PTY/IPC boundary, so a mock would not count.
 *
 * Covered: shows branch "main"; detached HEAD renders a 7-char SHA; a non-git cwd shows
 * `No git repos` and no `.repo-head`; the tab row holds no git chrome in any case (AC1); a rebase
 * in progress in a linked worktree with a dirty tree renders in the chip and its accessible name
 * (AC11). See docs/specs/2026-09-23-mf-changes.md §7.1, §7.4.
 *
 * Skips gracefully if git is unavailable or on non-win32 (the app/harness is Windows-only).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { assert, launchApp, makeLog, openChangesTab, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[git-indicator] SKIP — suite is Windows-only');
  process.exit(0);
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasGit()) {
  console.log('[git-indicator] SKIP — git not on PATH');
  process.exit(0);
}

const log = makeLog('git-indicator');
const tmps = [];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function gitInit(root, branch) {
  try {
    execFileSync('git', ['init', '-b', branch], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
      cwd: root,
      stdio: 'ignore',
    });
  }
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root, stdio: 'ignore' });
}

function commit(root) {
  writeFileSync(join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

function mkRepo(branch) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-gitind-'));
  tmps.push(root);
  gitInit(root, branch);
  commit(root);
  return root;
}

/** Poll the host-pushed session.repoGit[root], up to a ceiling (spec §7: 3000 ms). */
async function gitForSession(page, sid, root, predicate, timeout = 4000) {
  const handle = await page.waitForFunction(
    ({ id, r }) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return s?.repoGit?.[r] ?? null;
    },
    { id: sid, r: root },
    { timeout, polling: 100 },
  );
  const value = await handle.jsonValue();
  if (predicate && !predicate(value)) {
    throw Object.assign(new Error(`git predicate failed; got ${JSON.stringify(value)}`), {
      name: 'AssertionError',
    });
  }
  return value;
}

/** AC1: the tab row (DocTabs root) is rendered and holds no git control. */
async function assertNoTabRowGit(page, label) {
  const found = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tabbar-wrap')];
    const sel =
      '.git-indicator, .repo-picker, .branch-chip, [class*="git-indicator"], [class*="repo-picker"]';
    return { rows: rows.length, git: rows.reduce((n, r) => n + r.querySelectorAll(sel).length, 0) };
  });
  assert(found.rows > 0, `${label}: the tab row must be rendered`);
  assert(found.git === 0, `${label}: the tab row holds ${found.git} git control(s)`);
}

const readChipOnce = (page) =>
  page.evaluate(() => {
    const chip = document.querySelector('.repo-head .branch-chip');
    if (!chip) return null;
    return {
      label: chip.querySelector(':scope > .branch-chip__label')?.textContent ?? null,
      tag: chip.querySelector('.branch-chip__tag')?.textContent ?? null,
      op: chip.querySelector('.branch-chip__op')?.textContent ?? null,
      worktree: chip.querySelector('.branch-chip__worktree')?.textContent ?? null,
      dirty: !!chip.querySelector('.branch-chip__dirty'),
      text: chip.textContent,
      name: chip.getAttribute('aria-label'),
      heads: document.querySelectorAll('.repo-head').length,
    };
  });

/** The single repo head's chip, once `predicate` holds (polled, 6 s ceiling). */
async function readChip(page, predicate) {
  await openChangesTab(page);
  let last = null;
  for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
    last = await readChipOnce(page);
    if (last && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw Object.assign(new Error(`chip predicate failed; got ${JSON.stringify(last)}`), {
    name: 'AssertionError',
  });
}

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);

  // ── Scenario 1: shows the current branch "main" ─────────────────────────────
  const repoMain = mkRepo('main').replace(/\\/g, '/');
  const sidMain = await openSession(page, { path: repoMain });
  log('opened session in repo on main:', sidMain);

  const gitMain = await gitForSession(
    page,
    sidMain,
    repoMain,
    (g) => g.kind === 'branch' && g.branch === 'main',
  );
  log('host state git:', JSON.stringify(gitMain));
  assert(gitMain.kind === 'branch', `expected kind 'branch', got '${gitMain.kind}'`);
  assert(gitMain.branch === 'main', `expected branch 'main', got '${gitMain.branch}'`);

  const chipMain = await readChip(page, (v) => v.label === 'main');
  log('chip:', JSON.stringify(chipMain));
  assert(chipMain.heads === 1, `expected one repo head, got ${chipMain.heads}`);
  assert(chipMain.label === 'main', `expected branch label 'main', got '${chipMain.label}'`);
  assert(
    chipMain.op === null && chipMain.worktree === null && !chipMain.dirty,
    `a clean main chip carries extra state: ${JSON.stringify(chipMain)}`,
  );
  assert(
    chipMain.name === 'Branch main. Switch branch or view history',
    `chip name: ${chipMain.name}`,
  );
  await assertNoTabRowGit(page, 'branch');
  log('PASS: branch "main" shown in state + chip, tab row clean ✓');

  // ── Scenario 2: detached HEAD renders a 7-char SHA ──────────────────────────
  const repoDetached = mkRepo('main').replace(/\\/g, '/');
  const sha = git(repoDetached, ['rev-parse', 'HEAD']);
  git(repoDetached, ['checkout', '--detach', sha]);
  const sidDet = await openSession(page, { path: repoDetached });
  log('opened session in detached repo:', sidDet);

  const gitDet = await gitForSession(page, sidDet, repoDetached, (g) => g.kind === 'detached');
  log('detached host state git:', JSON.stringify(gitDet));
  assert(gitDet.kind === 'detached', `expected kind 'detached', got '${gitDet.kind}'`);
  assert(
    typeof gitDet.sha === 'string' && gitDet.sha.length === 7,
    `expected a 7-char sha, got '${gitDet.sha}'`,
  );
  assert(sha.startsWith(gitDet.sha), `sha '${gitDet.sha}' is not a prefix of HEAD '${sha}'`);
  assert(gitDet.branch === undefined, `detached must not carry a branch, got '${gitDet.branch}'`);

  const chipDet = await readChip(page, (v) => v.tag === 'detached');
  log('detached chip:', JSON.stringify(chipDet));
  assert(chipDet.label === gitDet.sha, `chip label '${chipDet.label}' != sha '${gitDet.sha}'`);
  assert(
    chipDet.name?.startsWith(`Detached at ${gitDet.sha}`),
    `detached chip name: ${chipDet.name}`,
  );
  await assertNoTabRowGit(page, 'detached');
  log('PASS: detached HEAD → 7-char SHA in state + chip ✓');

  // ── Scenario 3: a non-git cwd shows "No git repos" and no repo head ─────────
  const plainDir = mkdtempSync(join(tmpdir(), 'conduit-nogit-'));
  tmps.push(plainDir);
  const sidPlain = await openSession(page, { path: plainDir.replace(/\\/g, '/') });
  log('opened session in non-git dir:', sidPlain);

  await page.waitForFunction(
    (id) => Array.isArray((window.__sessions || []).find((x) => x.id === id)?.repos),
    sidPlain,
    { timeout: 4000, polling: 100 },
  );
  // Give the host a moment to interrogate + broadcast after the scan.
  await page.waitForTimeout(2000);
  const plainState = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? { repos: s.repos, repoGit: s.repoGit ?? null } : null;
  }, sidPlain);
  log('non-git host state:', JSON.stringify(plainState));
  assert(plainState !== null, 'non-git session must exist');
  assert(
    plainState.repos.length === 0,
    `non-git cwd must detect no repos, got ${JSON.stringify(plainState.repos)}`,
  );
  assert(
    plainState.repoGit === null || Object.keys(plainState.repoGit).length === 0,
    `non-git cwd must carry no repo git, got ${JSON.stringify(plainState.repoGit)}`,
  );

  // The Changes tab is still selected from scenario 2; with no repos it has no header to wait on.
  await page
    .locator('.right')
    .getByText('No git repos', { exact: true })
    .waitFor({ state: 'visible', timeout: 6000 });
  const plainDom = await page.evaluate(() => ({
    heads: document.querySelectorAll('.repo-head').length,
    chips: document.querySelectorAll('.branch-chip').length,
  }));
  log('non-git DOM:', JSON.stringify(plainDom));
  assert(plainDom.heads === 0, `expected no .repo-head, found ${plainDom.heads}`);
  assert(plainDom.chips === 0, `expected no .branch-chip, found ${plainDom.chips}`);
  await assertNoTabRowGit(page, 'non-git');
  log('PASS: non-git cwd → No git repos, no heads ✓');

  // ── Scenario 4 (AC11): rebase in progress, in a linked worktree, with a dirty tree ──
  const repoBase = mkRepo('main');
  const wtParent = mkdtempSync(join(tmpdir(), 'conduit-gitind-wt-'));
  tmps.push(wtParent);
  const wtPath = join(wtParent, 'wt-ac11');
  git(repoBase, ['worktree', 'add', '-b', 'topic', wtPath]);
  writeFileSync(join(wtPath, 'a.txt'), 'topic\n');
  git(wtPath, ['commit', '-am', 'topic edit']);
  writeFileSync(join(repoBase, 'a.txt'), 'main\n');
  git(repoBase, ['commit', '-am', 'main edit']);
  try {
    execFileSync('git', ['rebase', 'main'], { cwd: wtPath, stdio: 'ignore' });
  } catch {
    // Expected: both sides edited a.txt, so the rebase stops on the conflict.
  }
  const rebaseDir = git(wtPath, ['rev-parse', '--git-path', 'rebase-merge']);
  const rebaseAbs = isAbsolute(rebaseDir) ? rebaseDir : join(wtPath, rebaseDir);
  assert(existsSync(rebaseAbs), `no rebase in progress (missing ${rebaseAbs})`);

  const wtRoot = wtPath.replace(/\\/g, '/');
  const sidWt = await openSession(page, { path: wtRoot });
  const gitWt = await gitForSession(
    page,
    sidWt,
    wtRoot,
    (g) => g.operation === 'rebase' && g.isWorktree === true && g.dirty === true,
    8000,
  );
  log('AC11 host state git:', JSON.stringify(gitWt));
  const wtName = gitWt.worktreeName;
  assert(
    typeof wtName === 'string' && wtName.length > 0,
    `worktree name missing: ${JSON.stringify(gitWt)}`,
  );

  const chipWt = await readChip(page, (v) => v.op === 'REBASING');
  log('AC11 chip:', JSON.stringify(chipWt));
  assert(chipWt.text.includes('REBASING'), `chip text lacks REBASING: ${chipWt.text}`);
  assert(chipWt.worktree?.includes(wtName), `chip lacks worktree ${wtName}: ${chipWt.text}`);
  assert(chipWt.dirty, 'chip lacks .branch-chip__dirty');
  for (const part of ['REBASING', `worktree ${wtName}`, 'uncommitted changes']) {
    assert(chipWt.name?.includes(part), `chip aria-label lacks "${part}": ${chipWt.name}`);
  }
  await assertNoTabRowGit(page, 'rebase/worktree/dirty');
  log('PASS: AC11 rebase + worktree + dirty in the chip and its name ✓');

  await launched.cleanup();
  for (const p of tmps) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
  log('PASS ✓ branch chip: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[git-indicator] FAIL ✗', e.message);
  } else {
    console.error('[git-indicator] ERROR:', e?.message || e);
  }
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  for (const p of tmps) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(isAssertion ? 1 : 2);
}

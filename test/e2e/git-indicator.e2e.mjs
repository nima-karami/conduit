/**
 * Slice A — git branch/worktree indicator (FULL, runtime-observable).
 *
 * Drives the REAL hidden Electron app: seeds throwaway git repos in the OS temp dir,
 * opens each as a session cwd, and asserts both the host-pushed state
 * (`window.__sessions[sid].git`) AND the rendered DOM (`.git-indicator__*`). Crosses the
 * host/PTY/IPC boundary, so a mock would not count — this is the real-runtime proof.
 *
 * Covered Gherkin (spec §7): shows branch "main"; detached HEAD renders a 7-char SHA;
 * a non-git cwd attaches no `.git-indicator` element.
 *
 * Skips gracefully if git is unavailable or on non-win32 (the app/harness is Windows-only).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, tapBridge } from './harness.mjs';

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

/** Poll the host-pushed session.git for a session, up to a ceiling (spec §7: 3000 ms). */
async function gitForSession(page, sid, predicate, timeout = 4000) {
  const handle = await page.waitForFunction(
    ({ id }) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return s?.git ?? null;
    },
    { id: sid },
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

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);

  // ── Scenario 1: shows the current branch "main" ─────────────────────────────
  const repoMain = mkRepo('main');
  const sidMain = await openSession(page, { path: repoMain.replace(/\\/g, '/') });
  log('opened session in repo on main:', sidMain);

  const gitMain = await gitForSession(
    page,
    sidMain,
    (g) => g.kind === 'branch' && g.branch === 'main',
  );
  log('host state git:', JSON.stringify(gitMain));
  assert(gitMain.kind === 'branch', `expected kind 'branch', got '${gitMain.kind}'`);
  assert(gitMain.branch === 'main', `expected branch 'main', got '${gitMain.branch}'`);

  // The DOM .git-indicator__branch must show "main".
  const branchText = await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.git-indicator__branch .git-indicator__label');
        return el ? el.textContent : null;
      },
      null,
      { timeout: 4000 },
    )
    .then((h) => h.jsonValue());
  log('.git-indicator__branch label text:', branchText);
  assert(branchText === 'main', `expected branch label 'main', got '${branchText}'`);
  log('PASS: branch "main" shown in state + DOM ✓');

  // ── Scenario 2: detached HEAD renders a 7-char SHA ──────────────────────────
  const repoDetached = mkRepo('main');
  const sha = git(repoDetached, ['rev-parse', 'HEAD']);
  git(repoDetached, ['checkout', '--detach', sha]);
  const sidDet = await openSession(page, { path: repoDetached.replace(/\\/g, '/') });
  log('opened session in detached repo:', sidDet);

  const gitDet = await gitForSession(page, sidDet, (g) => g.kind === 'detached');
  log('detached host state git:', JSON.stringify(gitDet));
  assert(gitDet.kind === 'detached', `expected kind 'detached', got '${gitDet.kind}'`);
  assert(
    typeof gitDet.sha === 'string' && gitDet.sha.length === 7,
    `expected a 7-char sha, got '${gitDet.sha}'`,
  );
  assert(sha.startsWith(gitDet.sha), `sha '${gitDet.sha}' is not a prefix of HEAD '${sha}'`);
  assert(gitDet.branch === undefined, `detached must not carry a branch, got '${gitDet.branch}'`);
  log('PASS: detached HEAD → 7-char SHA ✓');

  // ── Scenario 3: a non-git cwd attaches no .git-indicator element ────────────
  const plainDir = mkdtempSync(join(tmpdir(), 'conduit-nogit-'));
  tmps.push(plainDir);
  const sidPlain = await openSession(page, { path: plainDir.replace(/\\/g, '/') });
  log('opened session in non-git dir:', sidPlain);

  // Give the host a moment to interrogate + broadcast (it resolves to kind 'none').
  await page.waitForTimeout(2000);
  const gitPlain = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? (s.git ?? null) : null;
  }, sidPlain);
  log('non-git host state git:', JSON.stringify(gitPlain));
  // kind 'none' is stripped to undefined host-side, so git must be absent.
  assert(gitPlain === null, `non-git cwd must carry no git, got ${JSON.stringify(gitPlain)}`);

  // With this session active, the .git-indicator element must not be attached.
  const indicatorCount = await page.evaluate(
    () => document.querySelectorAll('.git-indicator').length,
  );
  log('.git-indicator element count with non-git session active:', indicatorCount);
  assert(indicatorCount === 0, `expected no .git-indicator element, found ${indicatorCount}`);
  log('PASS: non-git cwd hides the indicator ✓');

  await launched.cleanup();
  for (const p of tmps) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
  log('PASS ✓ Slice A git indicator: all assertions passed');
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

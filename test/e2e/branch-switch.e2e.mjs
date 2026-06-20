/**
 * Slice B — git branch SWITCHER (FULL, runtime-observable).
 *
 * Drives the REAL hidden Electron app: seeds a throwaway git repo with two branches
 * (main + feature) as a session cwd, opens the branch dropdown, and asserts the host's
 * safe switch semantics across the IPC boundary (a mock wouldn't count):
 *   - open dropdown → git:refsResult lists both branches, current marked.
 *   - switch to feature while idle+clean → git:switchResult ok=true; session.git.branch
 *     becomes 'feature' within the refresh window; projectPath unchanged.
 *   - switch while the session is BUSY → ok=false reason='busy'; NO checkout ran.
 *   - switch with a DIRTY tree → ok=false reason='dirty'; NO checkout ran.
 *   - invalid (bogus) ref → ok=false reason='failed'; NO checkout ran.
 *
 * Captures a screenshot of the open dropdown to .autoloop/evidence/branch-switch.png.
 * Skips gracefully if git is unavailable or on non-win32 (the app/harness is Windows-only).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[branch-switch] SKIP — suite is Windows-only');
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
  console.log('[branch-switch] SKIP — git not on PATH');
  process.exit(0);
}

const log = makeLog('branch-switch');
const tmps = [];
const evidenceDir = join(REPO, '.autoloop', 'evidence');
mkdirSync(evidenceDir, { recursive: true });

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function mkRepoTwoBranches() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-brsw-'));
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
  git(root, ['branch', 'feature']);
  return root;
}

/** Subscribe a buffer for git:refsResult / git:switchResult (the parent harness tap only
 *  captures state + term:data). Idempotent per page. */
async function tapGit(page) {
  await page.evaluate(() => {
    if (window.__gitTapped) return;
    window.__gitTapped = true;
    window.__refs = null;
    window.__switch = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'git:refsResult') window.__refs = m;
      if (m.type === 'git:switchResult') window.__switch = m;
    });
  });
}

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

async function postSwitch(page, sid, ref) {
  await page.evaluate(
    ({ id, r }) => {
      window.__switch = null;
      window.agentDeck.post({
        type: 'git:switch',
        sessionId: id,
        target: { kind: 'branch', ref: r },
      });
    },
    { id: sid, r: ref },
  );
  const handle = await page.waitForFunction(() => window.__switch ?? null, null, { timeout: 6000 });
  return handle.jsonValue();
}

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  await tapGit(page);

  const repo = mkRepoTwoBranches();
  const sid = await openSession(page, { path: repo.replace(/\\/g, '/') });
  log('opened session on main:', sid);

  await gitForSession(page, sid, (g) => g.kind === 'branch' && g.branch === 'main');
  const projectPathBefore = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.projectPath ?? null,
    sid,
  );
  log('PASS: session is on branch "main" ✓');

  // ── Open the dropdown → git:refsResult lists both branches, current marked ───
  await page.evaluate((id) => window.agentDeck.post({ type: 'git:refs', sessionId: id }), sid);
  const refs = await page
    .waitForFunction(() => window.__refs ?? null, null, { timeout: 5000 })
    .then((h) => h.jsonValue());
  log('git:refsResult:', JSON.stringify(refs));
  assert(refs.branches.includes('main'), 'refs must include main');
  assert(refs.branches.includes('feature'), 'refs must include feature');
  assert(refs.current === 'main', `current must be main, got ${refs.current}`);
  log('PASS: refs list both branches, current marked ✓');

  // Open the real dropdown in the UI and screenshot it (clicks the switchable segment).
  try {
    await page.click('.git-indicator__branch--switchable', { timeout: 3000 });
    await page.waitForSelector('.git-branch-menu', { state: 'visible', timeout: 3000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(evidenceDir, 'branch-switch.png') });
    log('screenshot: .autoloop/evidence/branch-switch.png');
    await page.keyboard.press('Escape');
  } catch (e) {
    log('WARN: dropdown screenshot skipped:', e?.message || e);
  }

  // ── Switch to feature while idle + clean → ok=true, branch becomes feature ──
  const r1 = await postSwitch(page, sid, 'feature');
  log('switch idle+clean result:', JSON.stringify(r1));
  assert(r1.ok === true, `expected ok=true, got ${JSON.stringify(r1)}`);
  await gitForSession(page, sid, (g) => g.branch === 'feature', 5000);
  const onDisk1 = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(onDisk1 === 'feature', `on-disk HEAD should be feature, got ${onDisk1}`);
  const projectPathAfter = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.projectPath ?? null,
    sid,
  );
  assert(projectPathAfter === projectPathBefore, 'projectPath must be unchanged by a switch');
  log('PASS: idle+clean switch to feature works; projectPath unchanged ✓');

  // ── Switch while BUSY → ok=false reason=busy, no checkout ───────────────────
  // Start a long-running process so the host marks the session busy; wait for the
  // host-pushed busy flag before posting the switch.
  await page.evaluate(
    (id) =>
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: 'ping -n 6 127.0.0.1\r' }),
    sid,
  );
  await page.waitForFunction(
    (id) => !!(window.__sessions || []).find((s) => s.id === id)?.busy,
    sid,
    { timeout: 8000 },
  );
  const headBeforeBusy = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  const r2 = await postSwitch(page, sid, 'main');
  log('switch while busy result:', JSON.stringify(r2));
  assert(
    r2.ok === false && r2.reason === 'busy',
    `expected busy refusal, got ${JSON.stringify(r2)}`,
  );
  const headAfterBusy = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(headAfterBusy === headBeforeBusy, 'no checkout may run while busy');
  log('PASS: switch refused while busy, no checkout ✓');

  // Let the ping finish so the session goes idle for the dirty case.
  await page.waitForFunction(
    (id) => !(window.__sessions || []).find((s) => s.id === id)?.busy,
    sid,
    { timeout: 15000 },
  );

  // ── Switch with a DIRTY tree → ok=false reason=dirty, no checkout ───────────
  writeFileSync(join(repo, 'a.txt'), 'one\ndirty\n');
  const headBeforeDirty = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  const r3 = await postSwitch(page, sid, 'main');
  log('switch while dirty result:', JSON.stringify(r3));
  assert(
    r3.ok === false && r3.reason === 'dirty',
    `expected dirty refusal, got ${JSON.stringify(r3)}`,
  );
  const headAfterDirty = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(headAfterDirty === headBeforeDirty, 'no checkout may run while dirty');
  log('PASS: switch refused while dirty, no checkout ✓');

  // Clean the tree back so the invalid-ref case isn't conflated with dirty.
  git(repo, ['checkout', '--', 'a.txt']);

  // ── Invalid (bogus) ref → ok=false reason=failed, no checkout ───────────────
  const headBeforeBogus = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  const r4 = await postSwitch(page, sid, 'totally-bogus-ref-xyz');
  log('switch bogus ref result:', JSON.stringify(r4));
  assert(
    r4.ok === false && r4.reason === 'failed',
    `expected failed refusal for unknown ref, got ${JSON.stringify(r4)}`,
  );
  const headAfterBogus = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(headAfterBogus === headBeforeBogus, 'no checkout may run for an unknown ref');
  log('PASS: invalid ref rejected, no checkout ✓');

  log('PASS ✓ Slice B branch switcher: all assertions passed');
  await launched.cleanup();
  for (const p of tmps) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[branch-switch] FAIL ✗', e.message);
  else console.error('[branch-switch] ERROR:', e?.message || e);
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

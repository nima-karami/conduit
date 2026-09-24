/**
 * Slice B — git branch SWITCHER (FULL, runtime-observable).
 *
 * Drives the REAL hidden Electron app: seeds a throwaway git repo with two branches
 * (main + feature) as a session cwd, opens the repo head's branch chip menu, and asserts the
 * host's safe switch semantics across the IPC boundary (a mock wouldn't count). Every
 * git:refsResult / git:switchResult must echo the repo's root (docs/specs/2026-09-23-mf-changes.md
 * §2.3, AC6):
 *   - git:refsResult lists both branches, current marked; the chip menu lists them too.
 *   - pick feature in the chip menu while idle+clean → ok=true; session.repoGit[root].branch
 *     becomes 'feature', the chip reads feature and its live region announces
 *     "Switched to feature"; home unchanged.
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
import {
  assert,
  launchApp,
  makeLog,
  openChangesTab,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

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

/**
 * Poll the session's host-pushed GitInfo until `predicate` holds. The predicate runs HERE, not
 * in the page, so waitForFunction can't do the waiting for us — an earlier version resolved on
 * the first truthy `git` object and then asserted the predicate against it, which meant it was
 * really asserting "the refresh had already landed", and it read the pre-switch branch whenever
 * the host's post-checkout refresh took a beat longer than the round trip.
 */
async function gitForSession(page, sid, root, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  const read = () =>
    page.evaluate(
      ({ id, r }) => (window.__sessions || []).find((x) => x.id === id)?.repoGit?.[r] ?? null,
      { id: sid, r: root },
    );
  let value = await read();
  while (!(value && (!predicate || predicate(value))) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    value = await read();
  }
  if (!value || (predicate && !predicate(value))) {
    throw Object.assign(new Error(`git predicate failed; got ${JSON.stringify(value)}`), {
      name: 'AssertionError',
    });
  }
  return value;
}

const sameRoot = (a, b) =>
  typeof a === 'string' &&
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

async function waitSwitch(page) {
  const handle = await page.waitForFunction(() => window.__switch ?? null, null, { timeout: 6000 });
  return handle.jsonValue();
}

async function postSwitch(page, sid, repoRoot, ref) {
  await page.evaluate(
    ({ id, root, r }) => {
      window.__switch = null;
      window.agentDeck.post({
        type: 'git:switch',
        sessionId: id,
        repoRoot: root,
        target: { kind: 'branch', ref: r },
      });
    },
    { id: sid, root: repoRoot, r: ref },
  );
  return waitSwitch(page);
}

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  await tapGit(page);

  const repo = mkRepoTwoBranches().replace(/\\/g, '/');
  const sid = await openSession(page, { path: repo });
  log('opened session on main:', sid);

  await gitForSession(page, sid, repo, (g) => g.kind === 'branch' && g.branch === 'main');
  const homeBefore = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.home ?? null,
    sid,
  );
  const repoRoot = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.repos?.[0]?.root ?? null,
    sid,
  );
  assert(sameRoot(repoRoot, repo), `session must detect the repo, got ${repoRoot}`);
  log('PASS: session is on branch "main" ✓');

  // ── Open the chip menu → git:refsResult lists both branches, current marked ───
  await openChangesTab(page);
  await page.waitForFunction(
    () => document.querySelector('.repo-head .branch-chip')?.disabled === false,
    null,
    { timeout: 10000 },
  );
  await page.evaluate(() => {
    window.__refs = null;
  });
  await page.locator('.repo-head .branch-chip').click();
  const refs = await page
    .waitForFunction(() => window.__refs ?? null, null, { timeout: 5000 })
    .then((h) => h.jsonValue());
  log('git:refsResult:', JSON.stringify(refs));
  assert(refs.branches.includes('main'), 'refs must include main');
  assert(refs.branches.includes('feature'), 'refs must include feature');
  assert(refs.current === 'main', `current must be main, got ${refs.current}`);
  assert(sameRoot(refs.repoRoot, repoRoot), `refs must echo repoRoot, got ${refs.repoRoot}`);
  const menu = page.locator('.branch-chip-menu');
  const rows = menu.locator('.git-branch-menu__row');
  await rows.first().waitFor({ state: 'visible', timeout: 5000 });
  const rowNames = await rows.allTextContents();
  assert(
    rowNames.some((t) => t.includes('main')) && rowNames.some((t) => t.includes('feature')),
    `chip menu must list main + feature, got ${JSON.stringify(rowNames)}`,
  );
  const checked = await menu.locator('[role="menuitemradio"][aria-checked="true"]').textContent();
  assert(checked?.includes('main'), `current row must be main, got ${checked}`);
  await page.screenshot({ path: join(evidenceDir, 'branch-switch.png') });
  log('PASS: refs list both branches, current marked, repoRoot echoed ✓');

  // ── Pick feature in the chip menu while idle + clean → ok=true, branch becomes feature ──
  // The shell's startup output keeps the session busy for a busy window; the switch is only
  // "idle" once that has drained.
  await page.waitForFunction(
    (id) => !(window.__sessions || []).find((s) => s.id === id)?.busy,
    sid,
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    window.__switch = null;
  });
  await menu.locator('[role="menuitemradio"]', { hasText: 'feature' }).click();
  const r1 = await waitSwitch(page);
  log('switch idle+clean result:', JSON.stringify(r1));
  assert(r1.ok === true, `expected ok=true, got ${JSON.stringify(r1)}`);
  assert(sameRoot(r1.repoRoot, repoRoot), `switch must echo repoRoot, got ${r1.repoRoot}`);
  await gitForSession(page, sid, repo, (g) => g.branch === 'feature', 5000);
  await page.waitForFunction(
    () =>
      document.querySelector('.repo-head .branch-chip > .branch-chip__label')?.textContent ===
      'feature',
    null,
    { timeout: 5000 },
  );
  const live = await page.locator('.repo-head .branch-chip__live').textContent();
  assert(live === 'Switched to feature', `live region must announce the switch, got "${live}"`);
  const onDisk1 = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(onDisk1 === 'feature', `on-disk HEAD should be feature, got ${onDisk1}`);
  const homeAfter = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.home ?? null,
    sid,
  );
  assert(homeAfter === homeBefore, 'home must be unchanged by a switch');
  log('PASS: idle+clean switch to feature works; home unchanged ✓');

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
  const r2 = await postSwitch(page, sid, repoRoot, 'main');
  log('switch while busy result:', JSON.stringify(r2));
  assert(
    r2.ok === false && r2.reason === 'busy',
    `expected busy refusal, got ${JSON.stringify(r2)}`,
  );
  const headAfterBusy = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(headAfterBusy === headBeforeBusy, 'no checkout may run while busy');
  assert(sameRoot(r2.repoRoot, repoRoot), `busy refusal must echo repoRoot, got ${r2.repoRoot}`);
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
  const r3 = await postSwitch(page, sid, repoRoot, 'main');
  log('switch while dirty result:', JSON.stringify(r3));
  assert(
    r3.ok === false && r3.reason === 'dirty',
    `expected dirty refusal, got ${JSON.stringify(r3)}`,
  );
  const headAfterDirty = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(headAfterDirty === headBeforeDirty, 'no checkout may run while dirty');
  assert(sameRoot(r3.repoRoot, repoRoot), `dirty refusal must echo repoRoot, got ${r3.repoRoot}`);
  log('PASS: switch refused while dirty, no checkout ✓');

  // Clean the tree back so the invalid-ref case isn't conflated with dirty.
  git(repo, ['checkout', '--', 'a.txt']);

  // ── Invalid (bogus) ref → ok=false reason=failed, no checkout ───────────────
  const headBeforeBogus = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  const r4 = await postSwitch(page, sid, repoRoot, 'totally-bogus-ref-xyz');
  log('switch bogus ref result:', JSON.stringify(r4));
  assert(
    r4.ok === false && r4.reason === 'failed',
    `expected failed refusal for unknown ref, got ${JSON.stringify(r4)}`,
  );
  const headAfterBogus = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  assert(headAfterBogus === headBeforeBogus, 'no checkout may run for an unknown ref');
  assert(sameRoot(r4.repoRoot, repoRoot), `failed refusal must echo repoRoot, got ${r4.repoRoot}`);
  log('PASS: invalid ref rejected, no checkout ✓');

  log('PASS ✓ branch chip switcher: all assertions passed');
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

/**
 * Wedged git — every git invocation HANGS. Proves the end-to-end guarantee that a stalled git
 * (index.lock, dead network FS) can't pin a surface forever: the runner's timeout fires and the
 * commitDiff surface returns (empty) within a bounded time, and the app stays responsive throughout
 * (the host runs git async, so a hanging child never blocks the main thread).
 *
 * The fake git is a copy of node.exe that hangs whenever its "main script" name is a git subcommand
 * (so Electron's own main.js is unaffected), forced onto PATH via NODE_OPTIONS=--require.
 *
 * Invariant (fails the lane): a bounded git op returns within ~30s (NOT the 420s scenario cap) and
 * the app stays responsive. Advisory: reply time.
 */

import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvariant,
  closeApp,
  emitReport,
  gitCommitAll,
  initGitRepo,
  launchApp,
  makeLog,
  openSession,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';

const log = makeLog('git-wedged');

if (process.platform !== 'win32') {
  console.log('[git-wedged] SKIP — lane is Windows-only (non-win32 platform)');
  process.exit(0);
}

// Build the repo with the REAL git first, before wedging git for the launched app.
const repo = mkdtempSync(join(tmpdir(), 'conduit-wedged-repo-'));
initGitRepo(repo);
writeFileSync(join(repo, 'seed.txt'), 'seed\n');
const sha = gitCommitAll(repo, 'init');

// A hanging fake git: node.exe that spins forever when run as a git subcommand.
const shim = mkdtempSync(join(tmpdir(), 'conduit-wedged-git-'));
copyFileSync(process.execPath, join(shim, 'git.exe'));
const preload = join(shim, 'hang.cjs');
writeFileSync(
  preload,
  `const Module = require('module');
const path = require('path');
const orig = Module._load;
const GIT = new Set(['rev-parse','diff-tree','show','status','cat-file','check-ignore','blame','log','merge-base','show-ref','ls-files','diff','config','init','rev-list','symbolic-ref','for-each-ref','name-rev','describe','--version','version']);
Module._load = function (request, parent, isMain) {
  if (isMain && GIT.has(path.basename(String(request)))) { setInterval(() => {}, 1 << 30); return {}; }
  return orig.apply(this, arguments);
};
`,
);
const env = { PATH: `${shim};${process.env.PATH}`, NODE_OPTIONS: `--require ${preload}` };

let exitCode = 0;
let launched = null;
try {
  launched = await launchApp({ env });
  const { app, page } = launched;
  const sid = await openSession(page, { path: repo });
  log(`session ${sid} open under wedged git`);

  const t0 = Date.now();
  await startPerf(page, 'git-wedged');
  const result = await page.evaluate(
    ({ s, sha, root }) =>
      new Promise((resolve) => {
        window.agentDeck.subscribe((m) => {
          if (m.type === 'git:commitDiffResult' && m.sha === sha)
            resolve({ files: m.files.length });
        });
        window.agentDeck.post({ type: 'git:commitDiff', sessionId: s, sha, root, requestId: 1 });
      }),
    { s: sid, sha, root: repo.replace(/\\/g, '/') },
  );
  const report = await stopPerf(page);
  const replyMs = Date.now() - t0;
  const alive = (await page.evaluate(() => 1 + 1)) === 2;

  log(`commitDiff replied files=${result.files} in ${replyMs}ms, alive=${alive}`);
  emitReport('git-wedged', report, { replyMs, alive });

  assertInvariant(
    replyMs < 30000,
    `commitDiff must return (bounded) under a wedged git, took ${replyMs}ms — timeout not firing`,
  );
  assertInvariant(alive, 'app should stay responsive under a wedged git');
  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    exitCode = 1;
  } else {
    console.error('[git-wedged] ERROR:', e?.stack || e?.message || e);
    exitCode = 2;
  }
} finally {
  try {
    if (launched) await closeApp(launched.app, launched.page);
  } catch {
    /* best-effort */
  }
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(exitCode);
}

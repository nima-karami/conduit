/**
 * Non-git root file index (docs/plans/2026-10-16-multi-repo-tracking.plan.md Task 3.4): a folder
 * of repos is indexed as each repo's `git ls-files` plus the loose files outside every repo, so
 * quick-open and the TS source index honour each repo's `.gitignore`; an edit in one repo
 * re-lists that repo only.
 *
 * Layout: <ws> is not a repo and holds repoA (`.gitignore` = dist/ + gen/, with dist/x.ts and
 * gen/y.ts present), repoB and a loose notes.md. `dist` is also in the walk's fixed ignore set,
 * so gen/ is the dir that proves `.gitignore` is what excludes it.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGitProbe, readGitProbe, resetGitProbe } from './git-probe.mjs';
import { assert, closeApp, openSession, removeDir, runScenario, tapBridge } from './harness.mjs';

/** Long enough for the watcher, the renderer's incremental-index debounce and the host's build. */
const RELIST_BUDGET_MS = 15000;
const AFTER_RELIST_MS = 1500;

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

function initRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
}

const lsFiles = (calls) => calls.filter((c) => c.sub === 'ls-files' && c.args.includes('--others'));

async function waitOrFail(page, fn, arg, timeout, what, observe) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    const seen = await page.evaluate(observe, arg);
    assert(false, `${what} (observed ${JSON.stringify(seen)})`);
  }
}

runScenario('nonrepo-index', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-nonrepo-index-')));
  const ws = join(root, 'ws');
  const repoA = join(ws, 'repoA');
  const repoB = join(ws, 'repoB');
  try {
    initRepo(repoA, {
      '.gitignore': 'dist/\ngen/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    // Ignored, so present on disk only (git add -A skipped them).
    mkdirSync(join(repoA, 'dist'));
    writeFileSync(join(repoA, 'dist', 'x.ts'), 'export const x = 1;\n');
    mkdirSync(join(repoA, 'gen'));
    writeFileSync(join(repoA, 'gen', 'y.ts'), 'export const y = 1;\n');
    initRepo(repoB, { 'src/b.ts': 'export const b = 1;\n' });
    writeFileSync(join(ws, 'notes.md'), '# notes\n');

    await installGitProbe(app);
    const sid = await openSession(page, { path: slash(ws) });
    await waitOrFail(
      page,
      (id) => ((window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0) === 2,
      sid,
      30000,
      'the repo scan never registered repoA and repoB',
      (id) => (window.__sessions || []).find((s) => s.id === id)?.repos,
    );
    log('repo scan registered repoA + repoB');

    await tapBridge(page);
    const corpus = await page.evaluate(
      (r) =>
        new Promise((resolve) => {
          const off = window.agentDeck.subscribe((m) => {
            if (m.type !== 'searchResults' || m.root !== r) return;
            off?.();
            resolve(m.results.map((h) => h.rel));
          });
          window.agentDeck.post({ type: 'searchFiles', root: r, query: '' });
        }),
      slash(ws),
    );
    log(`quick-open corpus: ${JSON.stringify([...corpus].sort())}`);
    for (const want of ['repoA/src/a.ts', 'repoB/src/b.ts', 'notes.md'])
      assert(corpus.includes(want), `quick-open corpus lists ${want}`);
    for (const ignored of ['repoA/gen/y.ts', 'repoA/dist/x.ts'])
      assert(!corpus.includes(ignored), `quick-open corpus leaves out the gitignored ${ignored}`);
    log('quick-open: repo listings + loose file, gitignored files left out ✓');

    // The TS source index streams from the same index; the session-open index runs on its own.
    await waitOrFail(
      page,
      (suffix) => {
        const libs = window.monaco?.languages.typescript.typescriptDefaults.getExtraLibs() ?? {};
        return Object.keys(libs).some((k) => k.replace(/\\/g, '/').endsWith(suffix));
      },
      '/repoA/src/a.ts',
      30000,
      'the TS source index never received repoA/src/a.ts',
      () =>
        Object.keys(window.monaco?.languages.typescript.typescriptDefaults.getExtraLibs() ?? {}),
    );
    const leaked = await page.evaluate(
      (suffixes) => {
        const libs = window.monaco?.languages.typescript.typescriptDefaults.getExtraLibs() ?? {};
        return Object.keys(libs).filter((k) =>
          suffixes.some((s) => k.replace(/\\/g, '/').endsWith(s)),
        );
      },
      ['/repoA/gen/y.ts', '/repoA/dist/x.ts'],
    );
    assert(
      leaked.length === 0,
      `TS index leaves out gitignored files (got ${JSON.stringify(leaked)})`,
    );
    log('TS index: repoA/src/a.ts in, gitignored files out ✓');

    await resetGitProbe(app);
    appendFileSync(join(repoA, 'src', 'a.ts'), 'export const a2 = 2;\n');
    const deadline = Date.now() + RELIST_BUDGET_MS;
    let calls = [];
    for (;;) {
      calls = lsFiles(await readGitProbe(app));
      if (calls.some((c) => c.cwd === key(repoA))) break;
      assert(
        Date.now() < deadline,
        `the incremental index never re-listed repoA after an edit (ls-files cwds ${JSON.stringify(calls.map((c) => c.cwd))})`,
      );
      await pause(100);
    }
    await pause(AFTER_RELIST_MS);
    calls = lsFiles(await readGitProbe(app));
    const others = calls.filter((c) => c.cwd !== key(repoA) && c.cwd !== key(ws));
    assert(
      others.length === 0,
      `an edit in repoA re-listed no other repo (got ${JSON.stringify(others.map((c) => c.cwd))})`,
    );
    log(
      `edit in repoA → ${calls.filter((c) => c.cwd === key(repoA)).length} ls-files of repoA, 0 of repoB ✓`,
    );
  } finally {
    await closeApp(app, page);
    await removeDir(root);
  }
});

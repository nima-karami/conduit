/**
 * The TS source index of a folder of repos follows the repo set (search-scope review r1 SF). An
 * index built before the repo scan knows a repo (the race the review found) took that repo's
 * gitignored files in through the loose walk, and top-ups only add, so they stayed as extraLibs
 * for good. The host now re-syncs a non-git root's index when the repo set under it changes.
 *
 * The race is forced, not timed: repoA is a plain folder when the session opens and is indexed,
 * so the first index MUST see its gen/y.ts. Then repoA becomes a repo whose `.gitignore` names
 * gen/, the scan registers it, and gen/y.ts must leave the TS project while src/a.ts stays.
 *
 * The renderer's top-ups are parked (`__conduitHold` 'topup') from the first index on: `git init`,
 * `add` and `commit` fire watcher events whose top-ups re-sync on their own and would heal the race
 * without the host's repo-set re-sync (search-scope review r3).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, removeDir, runScenario, tapBridge } from './harness.mjs';

/** The session-open index waits 1.5 s, then streams; the re-scan, the re-sync and the flush. */
const INDEX_BUDGET_MS = 30000;

const hold = (app, at) => app.evaluate((_, a) => global.__conduitHold.hold(a), at);
const release = (app, at) => app.evaluate((_, a) => global.__conduitHold.release(a), at);

const slash = (p) => p.replace(/\\/g, '/');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

const libsEnding = (suffixes) => {
  const libs = window.monaco?.languages.typescript.typescriptDefaults.getExtraLibs() ?? {};
  return suffixes.filter((s) => Object.keys(libs).some((k) => k.replace(/\\/g, '/').endsWith(s)));
};

async function waitLibs(page, { present = [], absent = [] }, what) {
  try {
    await page.waitForFunction(
      ({ present, absent }) => {
        const libs = window.monaco?.languages.typescript.typescriptDefaults.getExtraLibs() ?? {};
        const keys = Object.keys(libs).map((k) => k.replace(/\\/g, '/'));
        const has = (s) => keys.some((k) => k.endsWith(s));
        return present.every(has) && !absent.some(has);
      },
      { present, absent },
      { timeout: INDEX_BUDGET_MS },
    );
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    const seen = await page.evaluate(libsEnding, [...present, ...absent]);
    assert(
      false,
      `${what} (of ${JSON.stringify([...present, ...absent])} the index holds ${JSON.stringify(seen)})`,
    );
  }
}

runScenario('index-repo-set', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-index-repo-set-')));
  const ws = join(root, 'ws');
  const repoA = join(ws, 'repoA');
  try {
    assert(await app.evaluate(() => !!global.__conduitHold), 'the smoke-only holds are installed');
    mkdirSync(join(repoA, 'src'), { recursive: true });
    mkdirSync(join(repoA, 'gen'), { recursive: true });
    writeFileSync(join(repoA, '.gitignore'), 'gen/\n');
    writeFileSync(join(repoA, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repoA, 'gen', 'y.ts'), 'export const y = 1;\n');

    const sid = await openSession(page, { path: slash(ws) });
    await waitLibs(
      page,
      { present: ['/repoA/src/a.ts', '/repoA/gen/y.ts'] },
      'with no repo registered, the first index takes in every .ts under the folder',
    );
    log('index built before any repo is known: a.ts and gen/y.ts both in');
    await hold(app, 'topup');

    git(repoA, 'init', '-q', '-b', 'main');
    git(repoA, 'config', 'user.email', 'test@example.com');
    git(repoA, 'config', 'user.name', 'Test');
    git(repoA, 'config', 'commit.gpgsign', 'false');
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-qm', 'seed');
    // The watcher sees the new .git too; an explicit (non-auto) refresh makes the re-scan prompt.
    await tapBridge(page);
    await page.evaluate(
      ([p, id]) => window.agentDeck.post({ type: 'requestProject', path: p, sessionId: id }),
      [slash(ws), sid],
    );
    await page.waitForFunction(
      (id) => ((window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0) === 1,
      sid,
      { timeout: INDEX_BUDGET_MS },
    );
    log('repo scan registered repoA');

    await waitLibs(
      page,
      { present: ['/repoA/src/a.ts'], absent: ['/repoA/gen/y.ts'] },
      'once repoA is registered, its gitignored gen/y.ts leaves the TS index and src/a.ts stays',
    );
    log('re-sync: gen/y.ts out, src/a.ts kept ✓');
  } finally {
    await release(app, 'topup');
    await closeApp(app, page);
    await removeDir(root);
  }
});

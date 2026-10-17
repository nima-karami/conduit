/**
 * The first TS index of a folder of repos, with a repo registered WHILE that index is being
 * built (search-scope review r2 SF1). The build read the repo set (none) and was still running,
 * so the root had no index state yet and the registration queued no re-sync: the repo's
 * gitignored gen/y.ts stayed an extraLib for good. The build now checks the repo set again once
 * its state exists.
 *
 * The race is held open, not timed, through the host's smoke-only holds (`__conduitHold`): repoA
 * is a repo on disk from the start, its scan is parked so the first build reads an empty repo set,
 * the build is parked before it records its state, the scan is let go and registers repoA, and
 * only then is the build let go. Renderer top-ups stay parked throughout: reading the tree fires
 * Windows directory change events, and the watcher top-up they cause re-syncs on its own, which
 * hid the race (measured: green with the fix removed until top-ups were parked).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, removeDir, runScenario, tapBridge } from './harness.mjs';

const BUDGET_MS = 30000;

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
      { timeout: BUDGET_MS },
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

const hold = (app, at) => app.evaluate((_, a) => global.__conduitHold.hold(a), at);
const release = (app, at) => app.evaluate((_, a) => global.__conduitHold.release(a), at);

async function waitHeld(app, at, what) {
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    if ((await app.evaluate((_, a) => global.__conduitHold.heldCount(a), at)) > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(false, what);
}

runScenario('index-repo-inflight', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-index-repo-inflight-')));
  const ws = join(root, 'ws');
  const repoA = join(ws, 'repoA');
  try {
    assert(await app.evaluate(() => !!global.__conduitHold), 'the smoke-only holds are installed');
    mkdirSync(join(repoA, 'src'), { recursive: true });
    mkdirSync(join(repoA, 'gen'), { recursive: true });
    writeFileSync(join(repoA, '.gitignore'), 'gen/\n');
    writeFileSync(join(repoA, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repoA, 'gen', 'y.ts'), 'export const y = 1;\n');
    git(repoA, 'init', '-q', '-b', 'main');
    git(repoA, 'config', 'user.email', 'test@example.com');
    git(repoA, 'config', 'user.name', 'Test');
    git(repoA, 'config', 'commit.gpgsign', 'false');
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-qm', 'seed');

    await hold(app, 'scan');
    await hold(app, 'index');
    await hold(app, 'topup');
    const sid = await openSession(page, { path: slash(ws) });
    await tapBridge(page);
    await waitHeld(app, 'index', 'the first index build never reached its hold');
    log('first index build parked after reading the repo set (none: the scan is parked too)');

    await release(app, 'scan');
    await page.waitForFunction(
      (id) => ((window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0) === 1,
      sid,
      { timeout: BUDGET_MS },
    );
    log('repoA registered while the first build is still parked');

    await release(app, 'index');
    await waitLibs(
      page,
      { present: ['/repoA/src/a.ts'], absent: ['/repoA/gen/y.ts'] },
      'a repo registered during the first build still takes its gitignored gen/y.ts out',
    );
    log('first build re-synced with every renderer top-up still parked: gen/y.ts out ✓');
  } finally {
    for (const at of ['scan', 'index', 'topup']) await release(app, at);
    await closeApp(app, page);
    await removeDir(root);
  }
});

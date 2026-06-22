/**
 * Real-app smoke: a recent folder whose directory no longer exists is filtered out of
 * the broadcast `state.repos` (host `reposForState` → `filterExistingRepos`), while an
 * existing one stays. Seeds `repos.json` in a throwaway user-data dir so the host loads
 * one present + one missing recent folder at startup, then asserts the live state.
 *
 * Standalone launch (not the shared `runScenario`) because it must seed `repos.json`
 * BEFORE the app reads it at startup; `launchApp` owns its own user-data dir.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, loadPlaywright, makeLog, REPO } from './harness.mjs';

const log = makeLog('recent-folders-prune');

if (process.platform !== 'win32') {
  console.log('[recent-folders-prune] SKIP — suite is Windows-only');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-ud-'));
const realRepo = mkdtempSync(join(tmpdir(), 'conduit-real-'));
const goneRepo = join(tmpdir(), `conduit-gone-${Date.now()}`); // never created → missing on disk
const fwd = (p) => p.replace(/\\/g, '/');

writeFileSync(
  join(userDataDir, 'repos.json'),
  JSON.stringify({
    version: 1,
    repos: [
      { path: fwd(realRepo), name: 'real', lastOpened: 2 },
      { path: fwd(goneRepo), name: 'gone', lastOpened: 1 },
    ],
  }),
);

const { _electron } = loadPlaywright();
const electronPath = require('electron');
let app;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });

  const paths = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.agentDeck.subscribe((m) => {
          if (m.type === 'state') resolve((m.repos || []).map((r) => r.path));
        });
        window.agentDeck.post({ type: 'ready' });
      }),
  );
  log('state.repos paths:', JSON.stringify(paths));

  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const has = (p) => paths.some((x) => norm(x) === norm(p));
  assert(has(realRepo), `existing recent folder should be present: ${realRepo}`);
  assert(!has(goneRepo), `deleted recent folder should be filtered out: ${goneRepo}`);

  log('PASS ✓');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.error(`[recent-folders-prune] ${isAssertion ? 'FAIL ✗' : 'ERROR'}:`, e?.message || e);
  process.exit(isAssertion ? 1 : 2);
} finally {
  try {
    await app?.close();
  } catch {
    /* already closed */
  }
  try {
    rmSync(realRepo, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

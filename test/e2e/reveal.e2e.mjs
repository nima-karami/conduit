/**
 * D2 — Reveal in Explorer (LITE)
 *
 * Trigger reveal on a DIRECTORY → assert shell.openPath(dir) was called.
 * Trigger reveal on a FILE → assert shell.showItemInFolder(file) was called.
 *
 * Uses main-process spy so no OS window needs to actually open.
 * Windows only.
 */

import { join } from 'node:path';
import {
  assert,
  assertCall,
  clearSpyCalls,
  finishScenario,
  getSpyCalls,
  launchApp,
  makeLog,
  openSession,
  REPO,
  spyMain,
  tapBridge,
  windowsOnlyScenario,
} from './harness.mjs';

await windowsOnlyScenario('reveal', 'cmd.exe shell and Explorer reveal');

const log = makeLog('reveal');

// Use well-known paths inside the repo that definitely exist.
const DIR_PATH = REPO.replace(/\\/g, '/');
const FILE_PATH = join(REPO, 'package.json').replace(/\\/g, '/');

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  await spyMain(app, [{ api: 'openPath' }, { api: 'showItemInFolder' }]);
  await tapBridge(page);
  await openSession(page, { path: DIR_PATH, agentId: 'shell:cmd' });

  const waitForCall = (api, path) =>
    app.evaluate(
      (_, { api, path }) =>
        new Promise((resolve) => {
          const deadline = Date.now() + 500;
          const poll = () => {
            const found = (global.__spyCalls || []).some(
              (c) => c.api === api && (path === null || c.args[0] === path),
            );
            if (found || Date.now() >= deadline) return resolve(found);
            setTimeout(poll, 25);
          };
          poll();
        }),
      { api, path },
    );
  // ── Test 1: reveal a DIRECTORY → openPath ───────────────────────────────────
  await clearSpyCalls(app);
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'revealInExplorer', path: p }),
    DIR_PATH,
  );
  assert(await waitForCall('openPath', DIR_PATH), 'directory reveal was not received');
  assert(
    !(await waitForCall('showItemInFolder', null)),
    'directory reveal invoked showItemInFolder',
  );
  const callsDir = await getSpyCalls(app);
  log(
    'calls after dir reveal:',
    JSON.stringify(callsDir.map((c) => ({ api: c.api, args: c.args }))),
  );

  assertCall(callsDir, 'openPath', (c) => c.args[0] === DIR_PATH);
  const noShowDir = !callsDir.some((c) => c.api === 'showItemInFolder');
  assert(noShowDir, 'showItemInFolder must NOT fire for a directory reveal');
  log('PASS: shell.openPath called for directory ✓');

  // ── Test 2: reveal a FILE → showItemInFolder ────────────────────────────────
  await clearSpyCalls(app);
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'revealInExplorer', path: p }),
    FILE_PATH,
  );
  assert(await waitForCall('showItemInFolder', FILE_PATH), 'file reveal was not received');
  assert(!(await waitForCall('openPath', null)), 'file reveal invoked openPath');
  const callsFile = await getSpyCalls(app);
  log(
    'calls after file reveal:',
    JSON.stringify(callsFile.map((c) => ({ api: c.api, args: c.args }))),
  );

  assertCall(callsFile, 'showItemInFolder', (c) => c.args[0] === FILE_PATH);
  const noOpenFile = !callsFile.some((c) => c.api === 'openPath');
  assert(noOpenFile, 'openPath must NOT fire for a file reveal');
  log('PASS: shell.showItemInFolder called for file ✓');

  await launched.cleanup();
  log('PASS ✓ D2 reveal-in-Explorer: all assertions passed');
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[reveal] FAIL ✗', e.message);
    await finishScenario(1);
  }
  console.error('[reveal] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  await finishScenario(2);
}

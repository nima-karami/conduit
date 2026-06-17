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
  getSpyCalls,
  launchApp,
  makeLog,
  openSession,
  REPO,
  spyMain,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[reveal] SKIP — suite is Windows-only');
  process.exit(0);
}

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

  // ── Test 1: reveal a DIRECTORY → openPath ───────────────────────────────────
  await clearSpyCalls(app);
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'revealInExplorer', path: p }),
    DIR_PATH,
  );
  await page.waitForTimeout(500);
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
  await page.waitForTimeout(500);
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
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[reveal] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[reveal] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

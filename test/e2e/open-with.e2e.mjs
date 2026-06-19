/**
 * open-with — Explorer "Open externally" / "Open with…" (LITE)
 *
 * "Open externally" → assert shell.openPath(file) was called (default-app open).
 * This proves the shared menu → IPC → host wiring via the recordable openPath spy.
 *
 * The "Open with…" win32 chooser spawns rundll32 OpenAs_RunDLL — a NATIVE dialog the
 * smoke harness can't drive — so it is needs-human-smoke (see the spec). The pure
 * command builder is unit-tested in test/unit/open-with.test.ts.
 *
 * Uses main-process spy so no OS window actually opens. Windows only.
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
  console.log('[open-with] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('open-with');

const DIR_PATH = REPO.replace(/\\/g, '/');
const FILE_PATH = join(REPO, 'package.json').replace(/\\/g, '/');

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  await spyMain(app, [{ api: 'openPath' }]);
  await tapBridge(page);
  await openSession(page, { path: DIR_PATH, agentId: 'shell:cmd' });

  // "Open externally" → shell.openPath(file) (default app).
  await clearSpyCalls(app);
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'openExternalPath', path: p }),
    FILE_PATH,
  );
  await page.waitForTimeout(500);
  const calls = await getSpyCalls(app);
  log(
    'calls after openExternalPath:',
    JSON.stringify(calls.map((c) => ({ api: c.api, args: c.args }))),
  );

  assertCall(calls, 'openPath', (c) => c.args[0] === FILE_PATH);
  assert(calls.filter((c) => c.api === 'openPath').length === 1, 'exactly one openPath call');
  log('PASS: shell.openPath called for "Open externally" ✓');

  await launched.cleanup();
  log('PASS ✓ open-with: all driveable assertions passed (chooser dialog = needs-human-smoke)');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[open-with] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[open-with] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

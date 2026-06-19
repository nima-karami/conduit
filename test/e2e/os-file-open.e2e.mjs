/**
 * Runtime smoke for "Open files in Conduit from the OS" (2026-06-19-os-file-open).
 *
 * The actual Explorer "Open with" launch and the NSIS registry keys cannot be driven by
 * the harness (OS-level boundaries). What we CAN exercise is the in-process path the OS
 * launch ultimately drives: the single-instance `second-instance` event → openArg →
 * openFileFromOS → openRepo → send({ type:'openFileInEditor' }) → the renderer handler that
 * opens the doc in the (just-created) session. We emit `second-instance` in the main process
 * with a seeded file argument and assert the file's doc tab appears in the renderer, proving
 * the host routing + the open-after-session-ready renderer handler work end to end.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, runScenario, tapBridge } from './harness.mjs';

runScenario('os-file-open', async ({ app, page, log }) => {
  await tapBridge(page);

  // Seed a real file on disk (not in a git repo → root falls back to its parent dir, so a
  // fresh session is created — exercising the open-after-session-ready deferral).
  const dir = mkdtempSync(join(tmpdir(), 'conduit-osopen-'));
  const filePath = join(dir, 'hello.ts');
  writeFileSync(filePath, 'export const greeting = "hi from the OS";\n');
  const fwd = filePath.replace(/\\/g, '/');
  log('seeded file', fwd);

  const before = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));

  // Emit the real single-instance event the OS launch would trigger. argv mirrors a packaged
  // launch: [exePath, "<file>"]. This runs the host's openArg for real (no stubbing).
  await app.evaluate((electron, p) => {
    electron.app.emit('second-instance', null, ['Conduit.exe', p]);
  }, filePath);

  // A new session is created for the file's parent dir.
  await page.waitForFunction(
    (ids) => (window.__sessions || []).some((s) => !ids.includes(s.id)),
    before,
    { timeout: 20000 },
  );
  log('new session created for the file root');

  // The renderer opened the file as a doc tab. Doc id is `file:<path>` (docs.ts idOf), with
  // the path exactly as the host sent it (native separators — backslashes on Windows).
  const tabid = `file:${filePath}`;
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-tabid="${CSS.escape(id)}"]`),
    tabid,
    { timeout: 20000 },
  );
  log('doc tab present for', tabid);

  // The opened doc is the active tab in the center pane.
  const active = await page.evaluate(
    (id) => !!document.querySelector(`[data-tabid="${CSS.escape(id)}"].tab--active`),
    tabid,
  );
  assert(active, 'expected the OS-opened file to be the active doc tab');
});

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
 *
 * Two cases:
 *   WARM — renderer already ready (the live `second-instance` path). argv mirrors a packaged
 *     launch realistically: argv[0] is the REAL executable path (an existing file on disk).
 *     This reproduces the BLOCKER where the arg parser classified the exe itself as the open
 *     target — if openArg didn't skip the exe, the doc tab would be the exe, not the file.
 *   COLD — the open is produced before the renderer subscribes (app-was-closed timing). The
 *     harness can't reproduce real cold timing (the page is always loaded here), so it drives
 *     the host's cold buffer/flush seam directly: readiness off → open buffered (not dropped)
 *     → flush → doc opens.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, runScenario, tapBridge } from './harness.mjs';

runScenario('os-file-open', async ({ app, page, log }) => {
  await tapBridge(page);

  // The real packaged argv[0] is the absolute exe path, which exists as a regular file. Use it
  // so the scenario would catch the BLOCKER (parser matching the exe itself).
  const exePath = await app.evaluate((electron) => electron.app.getPath('exe'));
  log('exe path (argv[0])', exePath);

  // ── WARM path ───────────────────────────────────────────────────────────────
  // Seed a real file on disk (not in a git repo → root falls back to its parent dir, so a
  // fresh session is created — exercising the open-after-session-ready deferral).
  const dir = mkdtempSync(join(tmpdir(), 'conduit-osopen-'));
  const filePath = join(dir, 'hello.ts');
  writeFileSync(filePath, 'export const greeting = "hi from the OS";\n');
  log('seeded file', filePath);

  const before = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));

  // Emit the real single-instance event the OS launch would trigger. argv mirrors a packaged
  // launch: [<absolute exe path>, "<file>"]. Runs the host's openArg for real (no stubbing).
  await app.evaluate(
    (electron, { exe, p }) => {
      electron.app.emit('second-instance', null, [exe, p]);
    },
    { exe: exePath, p: filePath },
  );

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
  assert(active, 'expected the OS-opened file to be the active doc tab (warm path)');

  // ── COLD path ───────────────────────────────────────────────────────────────
  // Model "app was closed": readiness OFF, emit a second-instance open, assert the host
  // buffered it (instead of dropping the one-shot send to a not-yet-subscribed renderer),
  // then flush via the readiness seam and assert the doc reaches the renderer.
  const coldDir = mkdtempSync(join(tmpdir(), 'conduit-osopen-cold-'));
  const coldFile = join(coldDir, 'cold.ts');
  writeFileSync(coldFile, 'export const cold = "opened before the renderer was ready";\n');
  log('seeded cold file', coldFile);

  const hookPresent = await app.evaluate(() => !!global.__osOpenColdHook);
  assert(hookPresent, 'expected the CONDUIT_E2E cold buffer/flush hook to be installed');

  const buffered = await app.evaluate(
    (electron, { exe, p }) => {
      global.__osOpenColdHook.setRendererReady(false);
      const depthBefore = global.__osOpenColdHook.pendingCount();
      electron.app.emit('second-instance', null, [exe, p]);
      return { depthBefore, depthAfter: global.__osOpenColdHook.pendingCount() };
    },
    { exe: exePath, p: coldFile },
  );
  log('cold open buffered', JSON.stringify(buffered));
  assert(
    buffered.depthAfter === buffered.depthBefore + 1,
    `expected the cold open to be buffered (queue ${buffered.depthBefore} → ${buffered.depthAfter})`,
  );

  // Flush — mirrors the renderer's first 'ready' arriving after cold launch.
  await app.evaluate(() => global.__osOpenColdHook.flush());

  const coldTabid = `file:${coldFile}`;
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-tabid="${CSS.escape(id)}"]`),
    coldTabid,
    { timeout: 20000 },
  );
  log('cold doc tab present after flush for', coldTabid);
  const coldActive = await page.evaluate(
    (id) => !!document.querySelector(`[data-tabid="${CSS.escape(id)}"].tab--active`),
    coldTabid,
  );
  assert(coldActive, 'expected the buffered cold-launch file to open after the readiness flush');
});

/**
 * Logging Slice A + B — real-runtime FS-boundary smoke.
 *
 * Drives the REAL app (CONDUIT_E2E=1 → the host logger writes to a temp logs dir under
 * os.tmpdir(), never real userData). Asserts:
 *   Slice A
 *   (a) a well-formed JSONL record is written to the active log file (ts/level/scope/msg);
 *   (b) a renderer-injected record carrying a sensitive key is persisted MASKED;
 *   (c) the `revealLogs` IPC opens the logs folder (shell.openPath spy).
 *   Slice B
 *   (d) a renderer `log.<level>(scope, msg)` call lands as a JSONL record with that level+scope;
 *   (e) `copyDiagnostics` writes a bundle (version header + log content) and reveals it
 *       (shell.showItemInFolder spy);
 *   (f) `readLogTail` returns recent lines.
 *
 * Windows only (matches the rest of the suite).
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertCall,
  clearSpyCalls,
  getSpyCalls,
  launchApp,
  makeLog,
  openSession,
  spyMain,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[logging] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('logging');
// Must match electron/logger.ts CONDUIT_E2E branch.
const LOGS_DIR = join(tmpdir(), 'conduit-e2e-logs');

/** Read every JSONL record from the newest conduit-*.log in the logs dir. */
function readRecords() {
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith('conduit-') && f.endsWith('.log'))
    .sort();
  const newest = files[files.length - 1];
  if (!newest) return [];
  return readFileSync(join(LOGS_DIR, newest), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  await spyMain(app, [{ api: 'openPath' }, { api: 'showItemInFolder' }]);
  await tapBridge(page);

  // Spawn a session → the host logs an info `pty spawn` record (FS write through the sink).
  // Use a tiny throwaway dir (not the huge REPO) so teardown's project/git watchers stay cheap.
  const workDir = mkdtempSync(join(tmpdir(), 'conduit-logwork-'));
  await openSession(page, { path: workDir.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // Inject a renderer→host log record with a sensitive key to prove redaction.
  await page.evaluate(() =>
    window.agentDeck.post({
      type: 'log',
      level: 'info',
      scope: 'e2e',
      message: 'redaction-probe',
      data: { token: 'super-secret-value', path: 'G:/awby/projects/conduit' },
    }),
  );
  await page.waitForTimeout(700); // let the debounced/async writes land

  const records = readRecords();
  log(`read ${records.length} JSONL record(s) from ${LOGS_DIR}`);
  assert(records.length > 0, 'expected at least one JSONL record in the active log file');

  // (a) well-formed: every record parses and carries the required fields.
  for (const r of records) {
    assert(typeof r.ts === 'number', 'record missing numeric ts');
    assert(typeof r.level === 'string', 'record missing level');
    assert(typeof r.scope === 'string', 'record missing scope');
    assert(typeof r.msg === 'string', 'record missing msg');
  }
  const spawn = records.find((r) => r.scope === 'pty' && r.msg === 'spawn' && r.level === 'info');
  assert(spawn, 'expected an info pty/spawn record from the session launch');
  log('PASS: well-formed JSONL pty/spawn record present ✓');

  // (b) redaction: the probe record persisted with the token masked, path intact.
  const probe = records.find((r) => r.scope === 'e2e' && r.msg === 'redaction-probe');
  assert(probe, 'expected the renderer-injected probe record');
  assert(probe.data.token === '[redacted]', `token must be redacted, got: ${probe.data.token}`);
  assert(probe.data.path === 'G:/awby/projects/conduit', 'path (repo data) must be kept intact');
  log('PASS: sensitive key redacted, path preserved ✓');

  // (c) revealLogs opens the logs folder via shell.openPath.
  await clearSpyCalls(app);
  await page.evaluate(() => window.agentDeck.revealLogs());
  await page.waitForTimeout(400);
  const calls = await getSpyCalls(app);
  assertCall(calls, 'openPath', (c) => String(c.args[0]).includes('conduit-e2e-logs'));
  log('PASS: revealLogs → shell.openPath(logsDir) ✓');

  // ── Slice B ──────────────────────────────────────────────────────────────

  // (d) renderer log.<level> parity: a typed call lands as a JSONL record with the right
  // level+scope (proves webview/log.ts → the `log` channel → the host's single disk writer).
  await page.waitForFunction(() => !!window.__conduitLog, null, { timeout: 10000 });
  await page.evaluate(() =>
    window.__conduitLog.warn('e2e-renderer', 'parity-probe', { kept: 'ok' }),
  );
  await page.waitForTimeout(600);
  const afterParity = readRecords();
  const parity = afterParity.find(
    (r) => r.scope === 'e2e-renderer' && r.msg === 'parity-probe' && r.level === 'warn',
  );
  assert(parity, 'expected a renderer log.warn record with scope e2e-renderer / level warn');
  assert(parity.data?.kept === 'ok', 'renderer log data should round-trip');
  log('PASS: renderer log.<level> parity record on disk ✓');

  // (e) copyDiagnostics: writes a bundle (version header + log content) and reveals it.
  await clearSpyCalls(app);
  const bundlePath = await page.evaluate(() => window.agentDeck.copyDiagnostics());
  await page.waitForTimeout(400);
  assert(
    typeof bundlePath === 'string' && bundlePath.length > 0,
    'copyDiagnostics returned no path',
  );
  const bundle = readFileSync(bundlePath, 'utf8');
  assert(bundle.includes('=== Conduit diagnostics ==='), 'bundle missing the version header');
  assert(/app:\s+\d/.test(bundle), 'bundle header missing an app version');
  assert(bundle.includes('parity-probe'), 'bundle missing recent log content');
  const diagCalls = await getSpyCalls(app);
  assertCall(diagCalls, 'showItemInFolder', (c) =>
    String(c.args[0]).includes('conduit-diagnostics-'),
  );
  log('PASS: copyDiagnostics → bundle (header + logs) + shell.showItemInFolder ✓');

  // (f) readLogTail: returns recent lines (not off, with content).
  const tail = await page.evaluate(() => window.agentDeck.readLogTail(100));
  assert(tail && tail.off === false, 'readLogTail should report logging on');
  assert(
    typeof tail.tail === 'string' && tail.tail.includes('parity-probe'),
    'tail missing recent content',
  );
  log('PASS: readLogTail returns recent lines ✓');

  await launched.cleanup();
  log('PASS ✓ logging Slice A + B: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[logging] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[logging] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

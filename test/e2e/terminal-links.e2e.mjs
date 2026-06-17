/**
 * D11 — Clickable file/folder paths in terminal output
 *
 * What we can verify end-to-end:
 *  1. pathExists IPC: host returns { exists, isDir } for a real file.
 *  2. pathExists IPC: host returns { exists: false } for a non-existent path.
 *  3. pathExists IPC: host correctly identifies a directory (isDir: true).
 *  4. The open flow works: readFile → fileContent for a known repo file.
 *
 * Residual needs-human-smoke:
 *  - Actual link click in the xterm canvas. xterm renders to a WebGL/DOM canvas;
 *    synthetic Playwright mouse events don't hit xterm's internal mouse handler at
 *    the correct position because xterm computes cell coordinates from canvas pixel
 *    offsets using its own internal glyph/font metrics. There is no reliable way to
 *    compute the pixel coordinate of a specific path token without parsing those
 *    metrics from the live canvas — effectively impossible to automate deterministically.
 *    The pure detection logic (detectPathTokens) is fully unit-tested in 30 vitest tests.
 *
 * Windows only.
 */

import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[terminal-links] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('terminal-links');

/** Post a pathExists message and wait for the pathExistsResult reply. */
async function checkPathExists(page, filePath, timeoutMs = 8000) {
  return page.evaluate(
    ({ path, ms }) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`pathExists IPC timeout for ${path}`)),
          ms,
        );
        const unsub = window.agentDeck.subscribe((msg) => {
          if (msg.type === 'pathExistsResult' && msg.path === path) {
            clearTimeout(timeout);
            unsub();
            resolve({ exists: msg.exists, isDir: msg.isDir });
          }
        });
        window.agentDeck.post({ type: 'pathExists', path });
      }),
    { path: filePath, ms: timeoutMs },
  );
}

/** Post readFile and wait for the fileContent response. */
async function readFileViaIpc(page, filePath, timeoutMs = 12000) {
  return page.evaluate(
    ({ path, ms }) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`readFile IPC timeout for ${path}`)), ms);
        const unsub = window.agentDeck.subscribe((msg) => {
          if (msg.type === 'fileContent' && msg.doc.path === path) {
            clearTimeout(timeout);
            unsub();
            resolve(msg.doc);
          }
        });
        window.agentDeck.post({ type: 'readFile', path });
      }),
    { path: filePath, ms: timeoutMs },
  );
}

let launched = null;
try {
  launched = await launchApp();
  const { page } = launched;

  await tapBridge(page);
  await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // Use well-known paths that exist in the repo.
  const KNOWN_FILE = join(REPO, 'package.json').replace(/\\/g, '/');
  const KNOWN_DIR = REPO.replace(/\\/g, '/');
  const MISSING_PATH = join(REPO, 'this-file-does-not-exist-d11.ts').replace(/\\/g, '/');

  // ── Test 1: pathExists for a real file ──────────────────────────────────────
  log('Test 1: pathExists for a real file');
  const fileResult = await checkPathExists(page, KNOWN_FILE);
  log('result:', JSON.stringify(fileResult));
  assert(fileResult.exists === true, `Test 1: expected exists=true for ${KNOWN_FILE}`);
  assert(fileResult.isDir === false, `Test 1: expected isDir=false for ${KNOWN_FILE}`);
  log('PASS: pathExists returns exists=true, isDir=false for a real file ✓');

  // ── Test 2: pathExists for a non-existent path ───────────────────────────────
  log('Test 2: pathExists for a non-existent path');
  const missingResult = await checkPathExists(page, MISSING_PATH);
  log('result:', JSON.stringify(missingResult));
  assert(missingResult.exists === false, `Test 2: expected exists=false for ${MISSING_PATH}`);
  log('PASS: pathExists returns exists=false for a missing path ✓');

  // ── Test 3: pathExists for a real directory ──────────────────────────────────
  log('Test 3: pathExists for a directory');
  const dirResult = await checkPathExists(page, KNOWN_DIR);
  log('result:', JSON.stringify(dirResult));
  assert(dirResult.exists === true, `Test 3: expected exists=true for ${KNOWN_DIR}`);
  assert(dirResult.isDir === true, `Test 3: expected isDir=true for ${KNOWN_DIR}`);
  log('PASS: pathExists returns exists=true, isDir=true for a directory ✓');

  // ── Test 4: readFile → fileContent (the file-open flow used on link click) ───
  log('Test 4: readFile IPC round-trip (file-open flow)');
  const doc = await readFileViaIpc(page, KNOWN_FILE);
  assert(
    typeof doc.content === 'string' && doc.content.length > 0,
    `Test 4: fileContent.content must be non-empty for ${KNOWN_FILE}`,
  );
  assert(doc.path === KNOWN_FILE, `Test 4: fileContent.path must echo the requested path`);
  assert(!doc.error, `Test 4: fileContent must have no error, got: ${doc.error}`);
  log('PASS: readFile → fileContent round-trip works ✓');

  log('All assertions passed ✓');
  log(
    'NOTE: actual link click (canvas hit-test) is residual needs-human-smoke — ' +
      'detection logic is covered by 30 vitest unit tests.',
  );

  await launched.cleanup();
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    log('FAIL ✗', e.message);
  } else {
    console.error('[terminal-links] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}

/**
 * D5 — File drag-and-drop move (FULL)
 *
 * 1. Creates a temp file inside the repo, moves it to another location inside
 *    the repo via the host's fsMove IPC; polls until moved on disk.
 * 2. Verifies a move OUTSIDE the project root is rejected by the path-guard.
 *
 * The fsMove IPC is the same path the drag-and-drop UI uses
 * (window.agentDeck.fsMove). Both ends must pass the path-guard containment
 * check before any disk mutation.
 *
 * Windows only.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[dnd] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('dnd');

// Scratch directory inside the repo for valid moves.
const SCRATCH = join(REPO, '.conduit', 'dnd-smoke-scratch');
mkdirSync(SCRATCH, { recursive: true });

// We use two sub-dirs so the path-guard allows both ends.
const SRC_DIR = join(SCRATCH, 'src');
const DST_DIR = join(SCRATCH, 'dst');
mkdirSync(SRC_DIR, { recursive: true });
mkdirSync(DST_DIR, { recursive: true });

// Create a unique test file in SRC_DIR.
const testFileName = `smoke-${Date.now()}.txt`;
const srcFile = join(SRC_DIR, testFileName);
const dstFile = join(DST_DIR, testFileName);
writeFileSync(srcFile, 'conduit-dnd-test\n');

// Outside-root path for path-guard rejection test.
const outsideFile = join(tmpdir(), `conduit-dnd-outside-${Date.now()}.txt`);
writeFileSync(outsideFile, 'should not move\n');

let launched;
try {
  launched = await launchApp();
  const { page } = launched;

  await tapBridge(page);
  // Open a session in the repo so the repo root is in the write-roots.
  await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });

  // ── Test 1: valid move inside project root ──────────────────────────────────
  log(`moving ${srcFile} → ${dstFile}`);
  const moveResult = await page.evaluate(({ from, to }) => window.agentDeck.fsMove(from, to), {
    from: srcFile.replace(/\\/g, '/'),
    to: dstFile.replace(/\\/g, '/'),
  });
  log('fsMove result:', JSON.stringify(moveResult));
  assert(moveResult?.ok === true, `fsMove returned not-ok: ${JSON.stringify(moveResult)}`);

  // Poll until the file appears at the destination and is gone from the source.
  const MAX_WAIT = 5000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    if (existsSync(dstFile) && !existsSync(srcFile)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(existsSync(dstFile), `File did not appear at destination: ${dstFile}`);
  assert(!existsSync(srcFile), `File still exists at source after move: ${srcFile}`);
  log('PASS: file moved on disk ✓');

  // ── Test 2: reject move outside project root (path-guard) ──────────────────
  // Try to move a file to a path outside the repo root.
  const outsideDst = join(tmpdir(), `conduit-dnd-moved-${Date.now()}.txt`);
  log(`attempting guarded move to outside root: ${outsideDst}`);
  const guardResult = await page.evaluate(({ from, to }) => window.agentDeck.fsMove(from, to), {
    from: dstFile.replace(/\\/g, '/'),
    to: outsideDst.replace(/\\/g, '/'),
  });
  log('path-guard result:', JSON.stringify(guardResult));
  assert(
    guardResult?.ok === false,
    `Path-guard should reject move outside root but got: ${JSON.stringify(guardResult)}`,
  );
  assert(existsSync(dstFile), 'File must be unchanged after path-guard rejection');
  assert(!existsSync(outsideDst), 'File must NOT appear outside root');
  log('PASS: path-guard rejected out-of-root move ✓');

  await launched.cleanup();

  // Clean up scratch files.
  try {
    const { rmSync } = await import('node:fs');
    rmSync(SCRATCH, { recursive: true, force: true });
    if (existsSync(outsideFile)) rmSync(outsideFile, { force: true });
  } catch {
    /* non-fatal cleanup */
  }

  log('PASS ✓ D5 file DnD: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[dnd] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[dnd] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  // Clean up scratch on error too.
  try {
    const { rmSync } = await import('node:fs');
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(2);
}

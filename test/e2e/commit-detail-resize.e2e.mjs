/**
 * commit-detail-resize — persist the History tab's commit-detail pane height across a real
 * restart (FULL). Crosses renderer → host → settings.json → renderer, which the mock preview
 * can't exercise.
 *
 * Two launches share ONE user-data dir (like editor-tabs-persist.e2e.mjs):
 *   1. Open a session in a temp git repo with commits, open the History tab from the git
 *      indicator, select a commit to reveal the detail pane (defaults to 300px), drag the
 *      `.gh__resizer` seam UP to enlarge it, and confirm the live height grew. Close the app
 *      (settings flush-on-unload persists historyDetailHeight).
 *   2. Relaunch on the SAME user-data dir. Open the History tab fresh, select a commit, and
 *      assert the detail pane seeds at the dragged height — NOT the 300px default.
 *
 * Without the feature (component-local useState(300)), launch 2 shows 300 → this fails.
 *
 * See docs/specs/2026-06-29-commit-detail-resize-persistence.md.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[commit-detail-resize] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('commit-detail-resize');

// A git repo with two commits so the History graph has rows + selectable detail.
const repo = mkdtempSync(join(tmpdir(), 'conduit-cdr-repo-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'e2e@conduit.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'conduit-e2e'], { cwd: repo });
  for (const [f, msg] of [
    ['a.txt', 'first commit'],
    ['b.txt', 'second commit'],
  ]) {
    writeFileSync(join(repo, f), `${f}\n`);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo });
  }
} catch (e) {
  console.error('[commit-detail-resize] ERROR: git fixture setup failed:', e?.message || e);
  process.exit(2);
}
const repoArg = repo.replace(/\\/g, '/');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-cdr-ud-'));
const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1200, height: 900 });
  return { app, page };
}

// Open the History tab for the active session via the git indicator, select the first commit
// row, and return the resulting `.gh__detail` pane height (px).
async function openHistoryDetailHeight(page) {
  await page.waitForSelector('.git-indicator', { state: 'attached', timeout: 30000 });
  await page.waitForSelector('.git-indicator__history', { state: 'attached', timeout: 30000 });
  await page.click('.git-indicator__history', { force: true });
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 20000 });
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__detail', { state: 'attached', timeout: 15000 });
  return page.evaluate(
    () => document.querySelector('.gh__detail')?.getBoundingClientRect().height ?? -1,
  );
}

let firstApp;
let secondApp;
try {
  // ── Launch 1: open History, drag the detail seam taller, persist on release ──────
  const first = await launch();
  firstApp = first.app;
  const { page: page1 } = first;

  const sid = await openSession(page1, { path: repoArg });
  assert(sid, 'no session id from openSession');
  log('launch 1: session', sid);

  const startH = await openHistoryDetailHeight(page1);
  log(`launch 1: detail pane starts at ${startH}px`);
  assert(Math.abs(startH - 300) < 2, `expected the first-run detail height ~300, got ${startH}`);

  // Drag the seam UP to enlarge the detail pane (it sits below the resizer; moving the seam up
  // grows it). Window-level pointer listeners drive the resize; release persists the height.
  const box = await page1.evaluate(() => {
    const r = document.querySelector('.gh__resizer')?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  assert(box, 'no .gh__resizer to drag');
  await page1.mouse.move(box.x, box.y);
  await page1.mouse.down();
  await page1.mouse.move(box.x, box.y - 60, { steps: 6 });
  await page1.mouse.move(box.x, box.y - 120, { steps: 6 });
  await page1.mouse.up();

  const draggedH = await page1.evaluate(
    () => document.querySelector('.gh__detail')?.getBoundingClientRect().height ?? -1,
  );
  log(`launch 1: dragged detail pane to ${draggedH}px`);
  assert(
    draggedH > startH + 40,
    `expected the drag to grow the pane (>${startH + 40}), got ${draggedH}`,
  );

  // Let the debounced settings persist (250ms) land, then close (flush-on-unload belt+braces).
  await page1.waitForTimeout(600);
  await closeApp(firstApp, page1);
  firstApp = null;
  log('launch 1 closed ✓');

  // ── Launch 2: the detail pane seeds at the persisted height across restart ────────
  const second = await launch();
  secondApp = second.app;
  const { page: page2 } = second;
  await tapBridge(page2);

  // Re-open the temp repo (its session may restore, but re-opening is deterministic) and drive
  // the History tab fresh — a brand-new GitHistoryView mount that must seed from settings.
  const sid2 = await openSession(page2, { path: repoArg });
  log('launch 2: session', sid2);

  const restoredH = await openHistoryDetailHeight(page2);
  log(`launch 2: detail pane seeded at ${restoredH}px (dragged was ${draggedH}px)`);
  assert(
    Math.abs(restoredH - 300) > 20,
    `expected the restored height to differ from the 300px default, got ${restoredH}`,
  );
  assert(
    Math.abs(restoredH - draggedH) < 8,
    `expected the restored height (~${draggedH}) to match the dragged height, got ${restoredH}`,
  );
  log('PASS: commit-detail pane height persisted across a full restart ✓');

  await closeApp(secondApp, page2);
  secondApp = null;

  log('PASS ✓ commit-detail-resize: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[commit-detail-resize] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[commit-detail-resize] ERROR:', e?.message || e);
  try {
    if (firstApp) await firstApp.close();
  } catch {
    /* ignore */
  }
  try {
    if (secondApp) await secondApp.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

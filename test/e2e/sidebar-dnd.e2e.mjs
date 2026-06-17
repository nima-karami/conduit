/**
 * W3 — Sidebar grouping: collapse + universal drag (FULL)
 *
 * Scenario 1 & 2: Sidebar card/header DnD — NEEDS-HUMAN-SMOKE.
 *   Synthetic DragEvents dispatched from page.evaluate() do not trigger React's
 *   DnD handlers reliably in Electron (the DataTransfer object constructed via
 *   `new DragEvent(...)` has a locked effectAllowed and the events do not carry
 *   the same flags as pointer-initiated drags). The pure commit logic (moveBefore
 *   + dropResolvesToManual + sortedCanonical) is fully covered by unit tests.
 *
 * Scenario 3: Collapse a group → cards hidden, header shows session count, and the
 *   collapsed state persists across a full app restart (reload persistence).
 *
 * Windows only.
 */

import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, loadPlaywright, makeLog, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[sidebar-dnd] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('sidebar-dnd');

const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launchOnDir(userDataDir) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  return { app, page };
}

// Shared user-data dir: collapse state must survive a relaunch on the same dir.
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-w3-'));
log('userDataDir:', userDataDir);

let app1 = null;
let app2 = null;
try {
  // ── Scenarios 1 & 2: DnD sort-flip — NEEDS-HUMAN-SMOKE ───────────────────
  log('Scenario 1 NEEDS-HUMAN-SMOKE: synthetic DragEvents from page.evaluate() do not');
  log('  trigger React DnD handlers in Electron (DataTransfer is locked on constructed');
  log('  DragEvents). The pure commit logic (moveBefore + dropResolvesToManual +');
  log('  sortedCanonical) is fully covered by unit tests in sidebar-grouping.test.ts.');
  log('Scenario 2 NEEDS-HUMAN-SMOKE: same reason; also requires ≥2 distinct projects.');

  // ── Scenario 3: Collapse + reload persistence ────────────────────────────
  log('Scenario 3: collapse a group and verify state persists across reload...');

  const launch1 = await launchOnDir(userDataDir);
  app1 = launch1.app;
  const { page } = launch1;

  await tapBridge(page);

  // Open a session so the sidebar has content to group.
  await page.evaluate(
    ({ p }) => window.agentDeck.post({ type: 'openRepo', path: p, agentId: 'shell:cmd' }),
    { p: REPO.replace(/\\/g, '/') },
  );
  const sid1 = await page
    .waitForFunction(
      () => (window.__sessions || []).find((s) => s.status === 'running')?.id || null,
      null,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
  assert(sid1, 'Session did not appear after openRepo');
  log('session opened:', sid1);

  // Wait for the sidebar to render. Default settings have sessionGroupByProject=true,
  // so the proj__label header and chevron should appear once a session is present.
  await page.waitForSelector('.proj__label', { state: 'attached', timeout: 10000 });
  log('.proj__label header visible ✓');

  // Confirm the chevron is present.
  await page.waitForSelector('.proj__chevron', { state: 'attached', timeout: 5000 });
  log('.proj__chevron visible ✓');

  // Count session cards before collapse.
  const cardsBefore = await page.evaluate(() => document.querySelectorAll('.session').length);
  assert(cardsBefore >= 1, `Expected ≥1 session card before collapse, got ${cardsBefore}`);
  log(`session cards before collapse: ${cardsBefore}`);

  // Click the chevron to collapse the group.
  await page.click('.proj__chevron');
  // Wait for the session cards to disappear (React re-render).
  await page.waitForFunction((n) => document.querySelectorAll('.session').length < n, cardsBefore, {
    timeout: 5000,
  });

  const cardsAfter = await page.evaluate(() => document.querySelectorAll('.session').length);
  assert(
    cardsAfter < cardsBefore,
    `Cards should be hidden after collapse (was ${cardsBefore}, now ${cardsAfter})`,
  );
  log(`session cards after collapse: ${cardsAfter} ✓`);

  // Session count badge should appear.
  const countText = await page.evaluate(() => {
    const el = document.querySelector('.proj__count');
    return el ? el.textContent?.trim() : null;
  });
  assert(countText !== null, 'proj__count element not found in collapsed header');
  assert(Number(countText) >= 1, `proj__count should be ≥1, got "${countText}"`);
  log(`session count badge: "${countText}" ✓`);

  // Flush settings before closing (debounce is 250ms; we've waited >400ms via the
  // waitForFunction, but dispatch pagehide to guarantee the flush runs).
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(500);

  await app1.close();
  app1 = null;
  log('first launch closed; relaunching on same userData dir...');

  // ── Relaunch: collapsed state must survive ────────────────────────────────
  const launch2 = await launchOnDir(userDataDir);
  app2 = launch2.app;
  const page2 = launch2.page;

  await tapBridge(page2);

  // Wait for the session to restore (status goes stale on reload by default).
  await page2.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id) || null,
    sid1,
    { timeout: 45000 },
  );
  log('session restored on relaunch ✓');

  // Allow React to render and settings to hydrate from the persisted file.
  await page2.waitForSelector('.proj__label', { state: 'attached', timeout: 10000 });
  await page2.waitForTimeout(600);

  // Cards should still be collapsed.
  const cardsAfterRelaunch = await page2.evaluate(
    () => document.querySelectorAll('.session').length,
  );
  assert(
    cardsAfterRelaunch < cardsBefore,
    `Collapsed state should persist: expected < ${cardsBefore} cards after reload, got ${cardsAfterRelaunch}`,
  );
  log(`cards after relaunch: ${cardsAfterRelaunch} — collapsed state persisted ✓`);

  // Count badge should still be visible.
  const countAfterRelaunch = await page2.evaluate(() => {
    const el = document.querySelector('.proj__count');
    return el ? el.textContent?.trim() : null;
  });
  assert(
    countAfterRelaunch !== null,
    'proj__count not visible after reload — collapse did not persist',
  );
  log(`session count badge after reload: "${countAfterRelaunch}" ✓`);

  await app2.close();
  app2 = null;

  log('');
  log('PASS ✓ W3 sidebar-dnd: all driveable assertions passed');
  log('  Scenario 1 NEEDS-HUMAN-SMOKE: card DnD sort-flip (synthetic DragEvents cannot');
  log('    drive React DnD in Electron; pure logic unit-tested)');
  log('  Scenario 2 NEEDS-HUMAN-SMOKE: header DnD sort-flip (same reason; requires ≥2 projects)');
  log('  Scenario 3 PASS: collapse + reload persistence');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[sidebar-dnd] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[sidebar-dnd] ERROR:', e?.message || e);
  try {
    if (app1) await app1.close();
  } catch {
    /* ignore */
  }
  try {
    if (app2) await app2.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}

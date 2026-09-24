/**
 * W3 — Sidebar grouping: collapse + universal drag (FULL)
 *
 * Scenario 1 & 2: Sidebar card/header DnD with a REAL mouse — NEEDS-HUMAN-SMOKE.
 *   Synthesized DragEvents sharing one DataTransfer do reach React: sidebar-projects.e2e.mjs
 *   proves card→header drops that way. What only a human can check is the pointer-driven drag
 *   itself (synthesis skips hit-testing). The commit logic is unit-tested.
 *
 * Scenario 3: Collapse a project group → its cards hidden, header shows its session count, the
 *   collapsed state is persisted keyed on the project id, and it survives a full app restart.
 *
 * Windows only.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  createProject,
  loadPlaywright,
  makeLog,
  REPO,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

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
let page1 = null;
let page2 = null;
// Every exit path goes through this: a bare app.close() with a live session waits on the quit
// guard forever, which turns a scenario that passed into a 210s TIMEOUT and leaves an Electron
// running for the rest of the suite.
const shutdownAll = async () => {
  await shutdownApp(app1, page1);
  app1 = null;
  await shutdownApp(app2, page2);
  app2 = null;
};
try {
  // ── Scenarios 1 & 2: DnD sort-flip — NEEDS-HUMAN-SMOKE ───────────────────
  log('Scenarios 1 & 2 NEEDS-HUMAN-SMOKE: a real-mouse card / header drag (synthesized drops');
  log('  are proved in sidebar-projects.e2e.mjs; the commit logic is unit-tested).');

  // ── Scenario 3: Collapse + reload persistence ────────────────────────────
  log('Scenario 3: collapse a group and verify state persists across reload...');

  const launch1 = await launchOnDir(userDataDir);
  app1 = launch1.app;
  const { page } = launch1;
  page1 = page;

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

  // File the session into a project so the group under test is keyed on a project id.
  const projectId = await createProject(page, 'dnd-proj');
  assert(projectId, 'createProject returned no id');
  await page.evaluate(
    ({ sid, pid }) =>
      window.agentDeck.post({ type: 'session:setProject', sessionId: sid, projectId: pid }),
    { sid: sid1, pid: projectId },
  );
  await page.waitForFunction(
    ({ sid, pid }) => (window.__sessions || []).find((s) => s.id === sid)?.projectId === pid,
    { sid: sid1, pid: projectId },
    { timeout: 10000 },
  );
  const header = page.locator('.proj', {
    has: page.locator('.proj__name', { hasText: 'dnd-proj' }),
  });
  await header.locator('.proj__label').waitFor({ state: 'attached', timeout: 10000 });
  log('dnd-proj header rendered ✓');
  const cardSel = `.session[data-sessionid="${sid1}"]`;
  await page.waitForSelector(cardSel, { state: 'attached', timeout: 5000 });
  assert((await header.locator(cardSel).count()) === 1, 'session card not under dnd-proj');

  const cardsBefore = await page.evaluate(() => document.querySelectorAll('.session').length);
  log(`session cards before collapse: ${cardsBefore}`);

  await header.locator('.proj__chevron').click();
  await page.waitForSelector(cardSel, { state: 'detached', timeout: 5000 });

  const cardsAfter = await page.evaluate(() => document.querySelectorAll('.session').length);
  assert(
    cardsAfter < cardsBefore,
    `Cards should be hidden after collapse (was ${cardsBefore}, now ${cardsAfter})`,
  );
  log(`session cards after collapse: ${cardsAfter} ✓`);

  const countText = (await header.locator('.proj__count').textContent())?.trim() ?? null;
  assert(countText === '1', `dnd-proj proj__count should be 1, got "${countText}"`);
  log(`session count badge: "${countText}" ✓`);

  // Flush settings before closing (debounce is 250ms; we've waited >400ms via the
  // waitForFunction, but dispatch pagehide to guarantee the flush runs).
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(500);

  const persisted = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'));
  const collapsed = persisted?.settings?.collapsedProjects;
  assert(
    JSON.stringify(collapsed) === JSON.stringify([projectId]),
    `settings.collapsedProjects should be [${projectId}], got ${JSON.stringify(collapsed)}`,
  );
  log('collapsedProjects persisted as the project id ✓');

  await shutdownApp(app1, page1);
  app1 = null;
  log('first launch closed; relaunching on same userData dir...');

  // ── Relaunch: collapsed state must survive ────────────────────────────────
  const launch2 = await launchOnDir(userDataDir);
  app2 = launch2.app;
  page2 = launch2.page;

  await tapBridge(page2);

  // Wait for the session to restore (status goes stale on reload by default).
  await page2.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id) || null,
    sid1,
    { timeout: 45000 },
  );
  log('session restored on relaunch ✓');

  // Allow React to render and settings to hydrate from the persisted file.
  const header2 = page2.locator('.proj', {
    has: page2.locator('.proj__name', { hasText: 'dnd-proj' }),
  });
  await header2.locator('.proj__label').waitFor({ state: 'attached', timeout: 10000 });
  await page2.waitForTimeout(600);

  // The project's card should still be collapsed away.
  assert(
    (await page2.locator(cardSel).count()) === 0,
    'Collapsed state should persist: the dnd-proj card is visible after reload',
  );
  // The relaunch opens the argv folder as another standalone session, so the rail-wide card
  // count isn't comparable across launches; the collapsed group itself must hold no card.
  const cardsInGroup = await header2.locator('.session').count();
  assert(
    cardsInGroup === 0,
    `Collapsed state should persist: dnd-proj shows ${cardsInGroup} card(s) after reload`,
  );
  log('dnd-proj group still collapsed after relaunch ✓');

  const countAfterRelaunch = (await header2.locator('.proj__count').textContent())?.trim() ?? null;
  assert(
    countAfterRelaunch === '1',
    `dnd-proj proj__count should read 1 after reload, got "${countAfterRelaunch}"`,
  );
  log(`session count badge after reload: "${countAfterRelaunch}" ✓`);

  await shutdownApp(app2, page2);
  app2 = null;

  log('');
  log('PASS ✓ W3 sidebar-dnd: all driveable assertions passed');
  log('  Scenarios 1 & 2 NEEDS-HUMAN-SMOKE: real-mouse card / header drag');
  log('  Scenario 3 PASS: project collapse keyed on its id + reload persistence');
  await shutdownAll();
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[sidebar-dnd] FAIL ✗', e.message);
  else console.error('[sidebar-dnd] ERROR:', e?.message || e, e?.stack ?? '');
  await shutdownAll().catch(() => {});
  process.exit(isAssertion ? 1 : 2);
}

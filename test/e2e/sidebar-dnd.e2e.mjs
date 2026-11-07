/**
 * W3 — Sidebar grouping: rank order, no manual reorder, fold + Space selection persistence.
 *
 * Scenario 1 & 2 (was: a real-mouse card / header drag re-sorting the rail): manual reorder is
 *   gone (sidebar-agent-tree spec §6). The tree's order is the spec's rank order — status groups
 *   Pinned, Needs you, Done, Working, Idle, Stopped, skipping empty ones — and a row dropped on
 *   another row changes neither order nor Space. Drops onto Space rows are proved in
 *   sidebar-projects.e2e.mjs.
 *
 * Scenario 3: fold a status group → its rows hidden, the header keeps its root count and says
 *   aria-expanded=false; the fold, the pin and the selected Space are persisted with this
 *   window's layout (windows.json sidebarUi) and survive a full app restart. The Pinned group is
 *   the one folded, because a restart turns every session stale and so changes its status group.
 *
 * Windows only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assert,
  createProject,
  finishScenario,
  launchElectron,
  makeLog,
  openSession,
  profileDir,
  REPO,
  selectSpace,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[sidebar-dnd] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('sidebar-dnd');

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const RANK = ['pinned', 'blocked', 'done', 'working', 'idle', 'stopped'];

async function launchOnDir(userDataDir) {
  const app = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  return { app, page };
}

/** The tree's direct children in DOM order: `group:<key>` for headers, the session id for rows. */
const treeOrder = (page) =>
  page.$$eval('[data-agent-tree] > [role="treeitem"]', (els) =>
    els.map((el) =>
      el.dataset.agentGroup !== undefined ? `group:${el.dataset.agentGroup}` : el.dataset.sessionid,
    ),
  );

async function rowMenu(page, sid, item) {
  await page
    .locator(`[data-agent-tree] .session[data-sessionid="${sid}"]`)
    .click({ button: 'right', position: { x: 30, y: 10 } });
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  await page
    .locator('.ctxmenu__item', { has: page.locator('.ctxmenu__label', { hasText: item }) })
    .click();
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
}

/** This window's persisted sidebarUi, or null until the debounced layout write lands. */
function persistedSidebarUi(userDataDir) {
  const file = join(userDataDir, 'windows.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'))?.windows?.[0]?.sidebarUi ?? null;
  } catch {
    // A read racing the atomic rename sees no file or a whole one; anything else retries.
    return null;
  }
}

// Shared user-data dir: the fold must survive a relaunch on the same dir.
const userDataDir = profileDir('w3');
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
  const launch1 = await launchOnDir(userDataDir);
  app1 = launch1.app;
  const { page } = launch1;
  page1 = page;
  await tapBridge(page);

  const sid1 = await openSession(page, { path: REPO });
  const sid2 = await openSession(page, { path: REPO });
  log('sessions opened:', sid1, sid2);

  // File sid1 into a project so the selection under test is keyed on a project id.
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
  await page
    .locator(`button[data-space-id="${projectId}"]`)
    .waitFor({ state: 'visible', timeout: 10000 });
  log('dnd-proj Space row rendered ✓');

  // ── Scenarios 1 & 2: rank order, and no manual reorder ─────────────────
  log('Scenarios 1 & 2: the tree is in rank order and a row-on-row drop reorders nothing...');
  await selectSpace(page, 'all');
  const order0 = await treeOrder(page);
  const groups0 = order0.filter((k) => k.startsWith('group:')).map((k) => k.slice(6));
  assert(
    groups0.length > 0 &&
      groups0.every((g, i) => i === 0 || RANK.indexOf(g) > RANK.indexOf(groups0[i - 1])),
    `status groups must follow rank order ${RANK.join(' > ')}, got ${JSON.stringify(groups0)}`,
  );
  assert(order0[0].startsWith('group:'), `the tree opens with a group header, got ${order0[0]}`);

  const bounds = await app1.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  const projectsBefore = await page.evaluate(() =>
    Object.fromEntries((window.__sessions || []).map((s) => [s.id, s.projectId ?? null])),
  );
  // dragend reports a point inside this window, so the host's cross-window hit-test no-ops.
  const dragged = await page.evaluate(
    async ({ from, onto, sx, sy }) => {
      const src = document.querySelector(`[data-agent-tree] .session[data-sessionid="${from}"]`);
      const dst = document.querySelector(`[data-agent-tree] .session[data-sessionid="${onto}"]`);
      if (!src || !dst) return { error: 'missing row' };
      const dt = new DataTransfer();
      const fire = (el, type, extra = {}) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }),
        );
      const tick = () => new Promise((r) => requestAnimationFrame(r));
      fire(src, 'dragstart');
      await tick();
      fire(dst, 'dragover');
      await tick();
      fire(dst, 'drop');
      await tick();
      fire(src, 'dragend', { screenX: sx, screenY: sy });
      return { draggable: src.getAttribute('draggable') };
    },
    {
      from: sid2,
      onto: sid1,
      sx: Math.round(bounds.x + bounds.width / 2),
      sy: Math.round(bounds.y + bounds.height / 2),
    },
  );
  assert(!dragged.error, `drag setup: ${dragged.error}`);
  // Rows stay draggable: a drag onto a Space row or another window is still a move.
  assert(dragged.draggable === 'true', `rows stay draggable, got ${dragged.draggable}`);
  try {
    await page.waitForFunction(
      ({ order, projects }) => {
        const currentOrder = [
          ...document.querySelectorAll('[data-agent-tree] > [role="treeitem"]'),
        ].map((el) =>
          el.dataset.agentGroup !== undefined
            ? `group:${el.dataset.agentGroup}`
            : el.dataset.sessionid,
        );
        const currentProjects = Object.fromEntries(
          (window.__sessions || []).map((s) => [s.id, s.projectId ?? null]),
        );
        return (
          JSON.stringify(currentOrder) !== JSON.stringify(order) ||
          JSON.stringify(currentProjects) !== JSON.stringify(projects)
        );
      },
      { order: order0, projects: projectsBefore },
      { timeout: 800 },
    );
    assert(false, 'row-on-row drop changed the tree or Space');
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
  }
  const order1 = await treeOrder(page);
  assert(
    JSON.stringify(order1) === JSON.stringify(order0),
    `a row dropped on a row must not reorder the tree: ${JSON.stringify({ order0, order1 })}`,
  );
  const projectsAfter = await page.evaluate(() =>
    Object.fromEntries((window.__sessions || []).map((s) => [s.id, s.projectId ?? null])),
  );
  assert(
    JSON.stringify(projectsAfter) === JSON.stringify(projectsBefore),
    'a row dropped on a row changes no Space',
  );
  log('rank order holds; row-on-row drop is a no-op ✓');

  // ── Scenario 3: fold + persistence ──────────────────────────────────────
  log('Scenario 3: fold a group and verify state persists across relaunch...');
  await rowMenu(page, sid1, 'Pin to top');
  await page.waitForFunction(
    (sid) => {
      const kids = [...document.querySelectorAll('[data-agent-tree] > [role="treeitem"]')];
      return (
        kids[0]?.getAttribute('data-agent-group') === 'pinned' &&
        kids[1]?.getAttribute('data-sessionid') === sid
      );
    },
    sid1,
    { timeout: 5000 },
  );
  log('pinned row leads the tree under Pinned ✓');

  await selectSpace(page, projectId);
  const rowSel = `[data-agent-tree] .session[data-sessionid="${sid1}"]`;
  await page.waitForSelector(rowSel, { state: 'attached', timeout: 5000 });
  assert(
    (await page.locator(`[data-agent-tree] .session[data-sessionid="${sid2}"]`).count()) === 0,
    'selecting dnd-proj hides the agent without a Space',
  );
  const header = page.locator('[data-agent-tree] button.proj__label[data-agent-group="pinned"]');
  assert((await header.getAttribute('aria-expanded')) === 'true', 'Pinned starts expanded');

  await header.click();
  await page.waitForSelector(rowSel, { state: 'detached', timeout: 5000 });
  assert(
    (await header.getAttribute('aria-expanded')) === 'false',
    'a folded group says aria-expanded=false',
  );
  const countText = (await header.locator('.proj__count').textContent())?.trim() ?? null;
  assert(countText === '1', `folded Pinned .proj__count should be 1, got "${countText}"`);
  const headerName = await header.getAttribute('aria-label');
  assert(headerName === 'Pinned (1)', `folded header name, got ${headerName}`);
  log(`folded Pinned: rows hidden, count "${countText}" ✓`);

  // The window's sidebar state rides the debounced layout write.
  await page.exposeFunction('__persistedSidebarUi', () => persistedSidebarUi(userDataDir));
  const ui = await page
    .waitForFunction(
      async (pid) => {
        const value = await window.__persistedSidebarUi();
        return value?.foldedGroups?.includes('pinned') && value?.selection?.projectId === pid
          ? value
          : null;
      },
      projectId,
      { timeout: 10000 },
    )
    .then((handle) => handle.jsonValue());
  await page.removeExposedFunction('__persistedSidebarUi');
  assert(
    ui?.foldedGroups?.includes('pinned') &&
      ui?.pinnedIds?.includes(sid1) &&
      ui?.selection?.kind === 'space' &&
      ui?.selection?.projectId === projectId,
    `windows.json sidebarUi should hold the fold, pin and Space, got ${JSON.stringify(ui)}`,
  );
  log('fold, pin and selected Space persisted with the window layout ✓');

  await shutdownApp(app1, page1);
  app1 = null;
  log('first launch closed; relaunching on same userData dir...');

  // ── Relaunch: fold and selection must survive ──────────────────────────
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

  await page2.waitForFunction(
    (pid) =>
      document.querySelector(`button[data-space-id="${pid}"]`)?.getAttribute('aria-pressed') ===
      'true',
    projectId,
    { timeout: 10000 },
  );
  log('dnd-proj is still the selected Space ✓');

  const header2 = page2.locator('[data-agent-tree] button.proj__label[data-agent-group="pinned"]');
  await header2.waitFor({ state: 'attached', timeout: 10000 });
  assert(
    (await header2.getAttribute('aria-expanded')) === 'false',
    'Folded state should persist: Pinned is expanded after relaunch',
  );
  // The relaunch opens the argv folder as another agent without a Space; the selection hides it,
  // and the folded group itself must show no row.
  const rowsShown = await page2.locator('[data-agent-tree] .session').count();
  assert(rowsShown === 0, `Folded state should persist: ${rowsShown} row(s) shown after relaunch`);
  const countAfterRelaunch = (await header2.locator('.proj__count').textContent())?.trim() ?? null;
  assert(
    countAfterRelaunch === '1',
    `Pinned .proj__count should read 1 after relaunch, got "${countAfterRelaunch}"`,
  );
  log(`Pinned still folded after relaunch, count "${countAfterRelaunch}" ✓`);

  await shutdownApp(app2, page2);
  app2 = null;

  log('');
  log('PASS ✓ W3 sidebar-dnd: all assertions passed');
  log('  Scenarios 1 & 2 PASS: rank order, no manual reorder');
  log('  Scenario 3 PASS: group fold + pin + Space selection survive a relaunch');
  await shutdownAll();
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[sidebar-dnd] FAIL ✗', e.message);
  else console.error('[sidebar-dnd] ERROR:', e?.message || e, e?.stack ?? '');
  await shutdownAll().catch(() => {});
  await finishScenario(isAssertion ? 1 : 2);
}

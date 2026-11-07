/**
 * Context-menu ordering & grouping consistency (2026-06-23 spec). Drives the REAL app and,
 * for each representative object menu, reads the rendered `.ctxmenu` and asserts the canonical
 * order: destructive item is LAST and separated, reference group is copies-then-reveal, and the
 * first rendered item never carries a leading separator. The editor-tab menu is pinned to its
 * EXACT item order in both variants (plain file and HTML) — its close-family-first order is
 * frozen by docs/specs/archive/2026-06-23-context-menu-consistency.md §4E.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  createProject,
  finishScenario,
  launchApp,
  makeLog,
  openSession,
  showRightView,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[ctx-menu-order] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('ctx-menu-order');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Right-click a selector and return the menu rows in order: {label, danger, sepBefore, disabled}. */
async function openMenuOn(page, selector) {
  await page.click(selector, { button: 'right' });
  await page.waitForSelector('.ctxmenu', { timeout: 8000 });
  // The items render with the menu itself; wait for the list, not for a settle.
  await page.waitForSelector('.ctxmenu .ctxmenu__scroll .ctxmenu__item', { timeout: 8000 });
  return page.evaluate(() => {
    // The item wrappers live in `.ctxmenu__scroll`, not directly under `.ctxmenu` — the frame
    // itself must not scroll or Neon's chamfer cuts the bottom of the CONTENT (blockers Q4).
    // Walking `.ctxmenu` instead collapses every row into one and reads as a leading separator.
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map((wrap) => {
      const item = wrap.querySelector('.ctxmenu__item');
      return {
        // The label span, not the last span: a row may carry a detail ("2 waiting") after it.
        label: item?.querySelector('.ctxmenu__label')?.textContent?.trim() ?? '',
        danger: !!item?.classList.contains('ctxmenu__item--danger'),
        sepBefore: !!wrap.querySelector('.ctxmenu__sep'),
        disabled: !!item?.disabled,
      };
    });
  });
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 }).catch(() => {});
}

/** Invariants every object menu must satisfy. */
function assertCanonical(name, rows) {
  assert(rows.length > 0, `${name}: menu should have items`);
  assert(!rows[0].sepBefore, `${name}: first item must not carry a leading separator`);
  const firstDangerIdx = rows.findIndex((r) => r.danger);
  if (firstDangerIdx >= 0) {
    // The destructive group is the FINAL group and is separated. Find its start (the nearest
    // separator at/above the first danger item); it must be a real group break, and no further
    // group break may appear after it (i.e. nothing follows the destructive group).
    let groupStart = firstDangerIdx;
    while (groupStart > 0 && !rows[groupStart].sepBefore) groupStart--;
    assert(
      groupStart > 0 && rows[groupStart].sepBefore,
      `${name}: the destructive group must be separated from the group above it`,
    );
    assert(
      !rows.slice(groupStart + 1).some((r) => r.sepBefore),
      `${name}: the destructive group must be the LAST group (no separators after it)`,
    );
  }
}

const labels = (rows) => rows.map((r) => r.label);

/** The frozen editor-tab order (§4E): the close family first, then the reference group, then
 *  the editor-group group (split-editor spec §9). */
const TAB_BASE = [
  'Close',
  'Close others',
  'Close to the right',
  'Close to the left',
  'Close all',
  'Copy path',
  'Copy name',
  'Reveal in Explorer',
];
const TAB_ORDER = [...TAB_BASE, 'Split Right', 'Move to Other Group'];
// An HTML tab extends the reference group at its tail — where 'Open in browser' used to sit.
// 'View source' is the label while the tab shows the rendered page, which is the default.
const HTML_TAB_ORDER = [
  ...TAB_BASE,
  'View source',
  'Open externally',
  'Split Right',
  'Move to Other Group',
];

/** Tag the tab whose title ends in `ext` so it can be addressed by selector, then pin it —
 *  a single click on a tree row opens a PREVIEW tab, whose menu carries an extra
 *  'Keep Open' row that would make the exact-order assertion depend on how it was opened. */
async function markAndPinTab(page, ext) {
  await page
    .waitForFunction(
      (suffix) =>
        Array.from(document.querySelectorAll('.tab')).some(
          (el) => !el.className.includes('terminal') && el.textContent?.includes(suffix),
        ),
      ext,
      { timeout: 15000 },
    )
    .catch(() => {});
  const found = await page.evaluate((suffix) => {
    for (const el of document.querySelectorAll('.tab[data-ctxtest]')) {
      el.removeAttribute('data-ctxtest');
    }
    const t = Array.from(document.querySelectorAll('.tab')).find(
      (el) => !el.className.includes('terminal') && el.textContent?.includes(suffix),
    );
    if (t) t.setAttribute('data-ctxtest', '1');
    return !!t;
  }, ext);
  if (!found) return false;
  await page.dblclick('.tab[data-ctxtest="1"]');
  await page.waitForSelector('.tab[data-ctxtest="1"]:not(.tab--preview)', { timeout: 8000 });
  return true;
}

let launched = null;
let repoDir = null;
try {
  repoDir = mkdtempSync(join(tmpdir(), 'conduit-ctxmenu-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 't@t.t'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  writeFileSync(join(repoDir, 'alpha.txt'), 'one\n');
  writeFileSync(join(repoDir, 'beta.txt'), 'two\n');
  writeFileSync(join(repoDir, 'report.html'), '<!doctype html><title>R</title><h1>R</h1>\n');
  git(['add', '.'], repoDir);
  git(['commit', '-qm', 'seed'], repoDir);
  writeFileSync(join(repoDir, 'alpha.txt'), 'one changed\n'); // a working-tree change

  launched = await launchApp();
  const { page } = launched;
  await tapBridge(page);
  const repoSid = await openSession(page, {
    path: repoDir.replace(/\\/g, '/'),
    agentId: 'shell:cmd',
  });

  // ── Session row ───────────────────────────────────────────────────────────
  // The order is webview/session-menu.ts buildSessionMenu's: Go to + Pin, then the optional
  // lifecycle / attention / messaging groups (environment-dependent here, so located rather than
  // pinned), then edit+move, reference, and the close family last.
  const rowSel = `[data-agent-tree] .session[data-sessionid="${repoSid}"]`;
  await page.waitForSelector(rowSel, { timeout: 15000 });
  const session = await openMenuOn(page, rowSel);
  log('session:', JSON.stringify(labels(session)));
  assertCanonical('session', session);
  const sl = labels(session);
  assert(
    JSON.stringify(sl.slice(0, 2)) === JSON.stringify(['Go to', 'Pin to top']),
    `session: opens with Go to, Pin to top, got ${JSON.stringify(sl.slice(0, 2))}`,
  );
  assert(session[2]?.sepBefore, 'session: a separator follows Go to / Pin to top');
  const timedI = sl.indexOf('Timed message…');
  const renameI = sl.indexOf('Rename');
  assert(timedI > 1 && timedI < renameI, 'session: Timed message… sits between Pin and Rename');
  const EDIT_MOVE = [
    'Rename',
    'Set icon…',
    'Duplicate session',
    'Move to space…',
    'Move to new window',
  ];
  assert(
    JSON.stringify(sl.slice(renameI, renameI + EDIT_MOVE.length)) === JSON.stringify(EDIT_MOVE),
    `session: edit/move group must be ${JSON.stringify(EDIT_MOVE)}, got ${JSON.stringify(sl.slice(renameI))}`,
  );
  assert(session[renameI].sepBefore, 'session: Rename opens its own group');
  assert(!sl.includes('Move to project…'), 'session: the old "Move to project…" label is gone');
  const TAIL = [
    'Copy home path',
    'Copy name',
    'Reveal in Explorer',
    'Close',
    'Close others',
    'Close all',
  ];
  assert(
    JSON.stringify(sl.slice(-TAIL.length)) === JSON.stringify(TAIL),
    `session: must end ${JSON.stringify(TAIL)}, got ${JSON.stringify(sl)}`,
  );
  const tail = session.slice(-TAIL.length);
  assert(tail[0].sepBefore && tail[3].sepBefore, 'session: reference and close groups separated');
  assert(
    tail.slice(3).every((r) => r.danger) && !tail.slice(0, 3).some((r) => r.danger),
    'session: exactly the close family is danger',
  );
  assert(!sl.includes('Copy path'), 'session: the old "Copy path" label is gone');
  await closeMenu(page);

  // ── Status group header: no menu of its own, the Agents pane menu ─────────
  // The sort menu is gone (spec §6): right-clicking a group header bubbles to the pane menu.
  const groupHead = '[data-agent-tree] button.proj__label[data-agent-group]';
  await page.waitForSelector(groupHead, { timeout: 5000 });
  const pane = await openMenuOn(page, groupHead);
  log('agents pane:', JSON.stringify(labels(pane)));
  assertCanonical('agents-pane', pane);
  assert(
    JSON.stringify(labels(pane)) ===
      JSON.stringify(['New agent', 'Close all sessions', 'Close all stale sessions']),
    `agents-pane: exactly New agent + bulk close, got ${JSON.stringify(labels(pane))}`,
  );
  await closeMenu(page);

  // ── Space row menus ───────────────────────────────────────────────────────
  const projectId = await createProject(page, 'ctx-proj');
  await page.evaluate(
    ({ sid, pid }) =>
      window.agentDeck.post({ type: 'session:setProject', sessionId: sid, projectId: pid }),
    { sid: repoSid, pid: projectId },
  );
  await page.waitForFunction(
    ({ sid, pid }) => (window.__sessions || []).find((s) => s.id === sid)?.projectId === pid,
    { sid: repoSid, pid: projectId },
    { timeout: 10000 },
  );
  const spaceSel = `button[data-space-id="${projectId}"]`;
  await page.waitForSelector(spaceSel, { timeout: 10000 });
  const SPACE_MENU = ['New agent in space', 'Open board', 'Rename…', 'Delete space…'];
  const spaceMenu = await openMenuOn(page, spaceSel);
  log('space row:', JSON.stringify(labels(spaceMenu)));
  assertCanonical('space-row', spaceMenu);
  assert(
    JSON.stringify(labels(spaceMenu)) === JSON.stringify(SPACE_MENU),
    `space-row: order must be exactly ${JSON.stringify(SPACE_MENU)}, got ${JSON.stringify(labels(spaceMenu))}`,
  );
  assert(
    spaceMenu[3].danger && spaceMenu[3].sepBefore,
    'space-row: Delete space… is danger and separated',
  );
  await closeMenu(page);
  // The argv folder's session has no Space, so the No space row is still there.
  await page.waitForSelector('button[data-space-id="no-space"]', { timeout: 10000 });
  const noSpace = await openMenuOn(page, 'button[data-space-id="no-space"]');
  log('no-space row:', JSON.stringify(labels(noSpace)));
  assert(
    JSON.stringify(labels(noSpace)) === JSON.stringify(['New agent without a space']),
    `no-space-row: must be exactly ["New agent without a space"], got ${JSON.stringify(labels(noSpace))}`,
  );
  await closeMenu(page);
  const allRow = await openMenuOn(page, 'button[data-space-id="all"]');
  log('all row:', JSON.stringify(labels(allRow)));
  assert(
    JSON.stringify(labels(allRow)) === JSON.stringify(['New agent']),
    `all-row: must be exactly ["New agent"], got ${JSON.stringify(labels(allRow))}`,
  );
  await closeMenu(page);

  // ── Change row (Changes tab) ──────────────────────────────────────────────
  await showRightView(page, 'changes');
  await page.waitForSelector('.change', { timeout: 15000 });
  const change = await openMenuOn(page, '.change');
  log('change:', JSON.stringify(labels(change)));
  assertCanonical('change', change);
  assert(
    labels(change)[change.length - 1] === 'Discard all changes',
    'change: last item must be "Discard all changes"',
  );
  const cCopy = labels(change).indexOf('Copy path');
  const cReveal = labels(change).indexOf('Reveal in Explorer');
  assert(cCopy >= 0 && cReveal > cCopy, 'change: Reveal must come after Copy path');
  await closeMenu(page);

  // ── File-tree node (Files tab) ────────────────────────────────────────────
  await showRightView(page, 'files');
  await page.waitForSelector('.filerow', { timeout: 15000 });
  const fileRow = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.filerow')).find((el) =>
      el.querySelector('.filerow__name')?.textContent?.endsWith('.txt'),
    );
    if (r) r.setAttribute('data-ctxtest', '1');
    return !!r;
  });
  assert(fileRow, 'a .txt file row should be present in the tree');
  const node = await openMenuOn(page, '.filerow[data-ctxtest="1"]');
  log('file node:', JSON.stringify(labels(node)));
  assertCanonical('file-node', node);
  assert(labels(node)[node.length - 1] === 'Delete', 'file-node: last item must be "Delete"');
  await closeMenu(page);

  // ── Editor-tab, plain file ────────────────────────────────────────────────
  await page.click('.filerow[data-ctxtest="1"]');
  await page.waitForSelector('.tab:not(.tab--terminal)', { timeout: 15000 });
  assert(await markAndPinTab(page, '.txt'), 'the .txt editor tab should be present');
  const tab = await openMenuOn(page, '.tab[data-ctxtest="1"]');
  log('editor tab:', JSON.stringify(labels(tab)));
  assertCanonical('editor-tab', tab);
  assert(
    JSON.stringify(labels(tab)) === JSON.stringify(TAB_ORDER),
    `editor-tab: order must be exactly ${JSON.stringify(TAB_ORDER)}, got ${JSON.stringify(labels(tab))}`,
  );
  await closeMenu(page);

  // ── Editor-tab, HTML file ─────────────────────────────────────────────────
  const htmlRow = await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('.filerow')).find((el) =>
      el.querySelector('.filerow__name')?.textContent?.endsWith('.html'),
    );
    if (r) r.setAttribute('data-ctxhtml', '1');
    return !!r;
  });
  assert(htmlRow, 'report.html should be present in the tree');
  await page.click('.filerow[data-ctxhtml="1"]');
  assert(await markAndPinTab(page, '.html'), 'the .html editor tab should be present');
  const htmlTab = await openMenuOn(page, '.tab[data-ctxtest="1"]');
  log('html editor tab:', JSON.stringify(labels(htmlTab)));
  assertCanonical('html-editor-tab', htmlTab);
  assert(
    JSON.stringify(labels(htmlTab)) === JSON.stringify(HTML_TAB_ORDER),
    `html-editor-tab: order must be exactly ${JSON.stringify(HTML_TAB_ORDER)}, got ${JSON.stringify(labels(htmlTab))}`,
  );
  await closeMenu(page);

  log('All assertions passed ✓');
  await launched.cleanup();
  rmSync(repoDir, { recursive: true, force: true });
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[ctx-menu-order] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    await launched?.cleanup();
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await finishScenario(isAssertion ? 1 : 2);
}

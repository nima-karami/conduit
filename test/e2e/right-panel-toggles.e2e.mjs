/**
 * The header's Files / Changes / Messages toggles drive the right panel (sidebar-agent-tree spec
 * §7, plan S0 selector contract + T5.2). The ONLY scenario that clicks a toggle directly: every
 * other scenario goes through `showRightView`, whose idempotence is proven here.
 *
 *  1. Contract: three toggles, aria-controls="right-pane", one pressed = the panel's view.
 *  2. Badges: a dirty repo's change count is described (aria-describedby), not in the name.
 *  3. Raw clicks: active closes the panel and the center widens; inactive opens or switches.
 *  4. showRightView: a second call for the shown view clicks nothing; a pressed toggle whose
 *     panel is not visible yet is waited for, never clicked (a click would close it).
 *  5. Imperative opens: Mod+Shift+F on a closed panel opens Files and focuses search; opening a
 *     file follows into Files. Both are transient: the remembered rightPaneTab is unchanged.
 *  6. Persistence across reload: the remembered view, and the panel's open/closed state.
 *  7. Palette routes: feature board, architecture canvas, back to the editor.
 *  8. The panel context menu moves the side panel.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  openSession,
  runCommand,
  runScenario,
  shownRightView,
  showRightView,
  tapBridge,
  waitForRepoGit,
} from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

const DIRTY = ['alpha.ts', 'beta.ts', 'gamma.ts'];

/** Three tracked files modified and nothing else, so the Changes count is exactly 3. */
function makeDirtyRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-right-panel-toggles-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const f of DIRTY) writeFileSync(join(root, f), `export const ${f[0]} = 1;\n`);
  writeFileSync(join(root, 'clean.md'), '# clean\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  for (const f of DIRTY) writeFileSync(join(root, f), `export const ${f[0]} = 2;\n`);
  return root;
}

const toggle = (page, view) => page.locator(`button[data-right-view="${view}"]`);
const panel = (page) => page.locator('#right-pane');

/** The persisted settings the host owns; absent until the first change (= defaults). */
async function readSettings(app) {
  const dir = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const file = join(dir, 'settings.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).settings ?? null;
  } catch {
    // Read mid-write (atomic rename on the host side, but be safe): the caller polls again.
    return null;
  }
}

/** Poll the persisted settings until `pred` holds; returns the last read either way. */
async function waitSettings(app, pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let s = await readSettings(app);
  while (!(s && pred(s)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    s = await readSettings(app);
  }
  return s;
}

const centerWidth = (page) =>
  page.evaluate(
    () => document.querySelector('main.centerpane')?.getBoundingClientRect().width ?? -1,
  );
const panelBox = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('#right-pane')?.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.x, width: r.width } : null;
  });

/** Every toggle's pressed state, in header order. */
const pressedStates = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('button[data-right-view]')].map(
      (b) => `${b.getAttribute('data-right-view')}=${b.getAttribute('aria-pressed')}`,
    ),
  );

/** App shortcuts are left to the shell while an xterm has focus, so park focus on the chrome. */
const blur = (page) =>
  page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

async function waitShown(page, view, what) {
  const ok = await page
    .waitForFunction(
      (v) => {
        const pressed = [...document.querySelectorAll('button[data-right-view]')].filter(
          (b) => b.getAttribute('aria-pressed') === 'true',
        );
        const aside = document.querySelector('#right-pane');
        if (v === null) return pressed.length === 0 && (!aside || aside.offsetWidth === 0);
        return (
          pressed.length === 1 &&
          pressed[0].getAttribute('data-right-view') === v &&
          aside?.getAttribute('data-right-view') === v &&
          aside.offsetWidth > 0
        );
      },
      view,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    ok,
    `${what}: expected ${view ?? 'a closed panel'}, toggles ${JSON.stringify(await pressedStates(page))}, panel ${await panel(
      page,
    )
      .getAttribute('data-right-view')
      .catch(() => 'absent')}`,
  );
}

/** Counts every click that reaches a header toggle (capture phase, so nothing can hide one). */
const armClickCounter = (page) =>
  page.evaluate(() => {
    window.__toggleClicks = 0;
    if (window.__toggleCounterArmed) return;
    window.__toggleCounterArmed = true;
    document.addEventListener(
      'click',
      (e) => {
        if (e.target instanceof Element && e.target.closest('button[data-right-view]'))
          window.__toggleClicks++;
      },
      true,
    );
  });
const toggleClicks = (page) => page.evaluate(() => window.__toggleClicks ?? -1);

async function reloadApp(page) {
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await toggle(page, 'files').waitFor({ state: 'visible', timeout: 20000 });
}

runScenario('right-panel-toggles', async ({ app, page, log }) => {
  const root = makeDirtyRepo();
  await openSession(page, { path: root.replace(/\\/g, '/') });
  await waitForRepoGit(page);
  await blur(page);

  // ── 1. Contract ───────────────────────────────────────────────────────────
  for (const [view, label] of [
    ['files', 'Files'],
    ['changes', 'Changes'],
    ['messages', 'Messages'],
  ]) {
    const t = toggle(page, view);
    await t.waitFor({ state: 'visible', timeout: 15000 });
    assert((await t.getAttribute('aria-label')) === label, `${view} toggle is named "${label}"`);
    assert(
      (await t.getAttribute('aria-controls')) === 'right-pane',
      `${view} toggle controls #right-pane`,
    );
    assert(
      ['true', 'false'].includes(await t.getAttribute('aria-pressed')),
      `${view} toggle carries aria-pressed`,
    );
  }
  assert(
    (await page.locator('.rightpane__tabs').count()) === 0,
    'no right-panel tab strip remains (.rightpane__tabs)',
  );
  // A fresh profile: the panel open on the default Files view.
  await waitShown(page, 'files', 'fresh profile');
  assert(
    (await panel(page).getAttribute('aria-label')) === 'Files',
    'the panel is labelled by its view',
  );
  log('toggle contract ✓');

  // ── 2. Badges ─────────────────────────────────────────────────────────────
  const badgeOk = await page
    .waitForFunction(
      (n) =>
        document
          .querySelector('button[data-right-view="changes"] .topbar__badge')
          ?.textContent?.trim() === String(n),
      DIRTY.length,
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    badgeOk,
    `Changes badge shows ${DIRTY.length} while Files is the shown view (got ${JSON.stringify(
      await page
        .locator('button[data-right-view="changes"] .topbar__badge')
        .textContent()
        .catch(() => null),
    )})`,
  );
  const changes = toggle(page, 'changes');
  assert(
    (await changes.getAttribute('aria-label')) === 'Changes',
    'the badge count is not in the accessible name',
  );
  const describedBy = await changes.getAttribute('aria-describedby');
  assert(describedBy, 'the Changes badge is described via aria-describedby');
  const description = await page.evaluate(
    (id) => document.getElementById(id)?.textContent ?? null,
    describedBy,
  );
  assert(
    description === `${DIRTY.length} changes`,
    `Changes description reads "${DIRTY.length} changes" (got ${JSON.stringify(description)})`,
  );
  assert(
    (await toggle(page, 'files').getAttribute('aria-describedby')) === null,
    'a toggle without a badge has no description',
  );
  log(`Changes badge ${DIRTY.length}, described not named ✓`);

  // ── 3. Raw toggle clicks ──────────────────────────────────────────────────
  const openWidth = await centerWidth(page);
  const openPanel = await panelBox(page);
  assert(openPanel, 'the open panel has a box');
  await toggle(page, 'files').click();
  await waitShown(page, null, 'clicking the active toggle');
  const closedWidth = await centerWidth(page);
  assert(
    closedWidth > openWidth + openPanel.width / 2,
    `closing the panel returns its width to the center (center ${openWidth}px → ${closedWidth}px, panel was ${openPanel.width}px)`,
  );

  await changes.click();
  await waitShown(page, 'changes', 'clicking an inactive toggle on a closed panel');
  await page.waitForSelector('.changes__header', { state: 'visible', timeout: 15000 });
  const reopenedWidth = await centerWidth(page);
  assert(
    Math.abs(reopenedWidth - openWidth) <= 2,
    `reopening takes the panel's width back from the center (${openWidth}px → ${reopenedWidth}px)`,
  );
  let s = await waitSettings(app, (x) => x.rightPaneTab === 'changes');
  assert(
    s?.rightPaneTab === 'changes',
    `an explicit pick is remembered (rightPaneTab ${s?.rightPaneTab})`,
  );

  await toggle(page, 'messages').click();
  await waitShown(page, 'messages', 'switching views on an open panel');
  assert(
    Math.abs((await centerWidth(page)) - openWidth) <= 2,
    'switching views leaves the center width alone',
  );
  await toggle(page, 'files').click();
  await waitShown(page, 'files', 'switching back to Files');
  s = await waitSettings(app, (x) => x.rightPaneTab === 'files');
  assert(
    s?.rightPaneTab === 'files',
    `the last explicit pick wins (rightPaneTab ${s?.rightPaneTab})`,
  );
  log('raw clicks: active closes + center widens, inactive opens/switches, picks persist ✓');

  // ── 4. showRightView idempotence ──────────────────────────────────────────
  await armClickCounter(page);
  await showRightView(page, 'files');
  await showRightView(page, 'files');
  assert((await toggleClicks(page)) === 0, 'showRightView on the shown view clicks nothing');
  await waitShown(page, 'files', 'showRightView twice on the shown view');

  // Pressed, but the panel not visible yet: what a mounting panel looks like to the helper.
  await page.evaluate(() => {
    document.querySelector('#right-pane').style.display = 'none';
  });
  const pending = showRightView(page, 'files');
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Held long enough that a helper which does not wait would already have clicked.
  await page.waitForTimeout(700);
  assert(!settled, 'showRightView waits while the pressed toggle has no visible panel');
  await page.evaluate(() => {
    document.querySelector('#right-pane').style.display = '';
  });
  await pending;
  assert((await toggleClicks(page)) === 0, 'showRightView never clicks a pressed toggle');
  await waitShown(page, 'files', 'after the mounting panel appeared');

  await showRightView(page, 'changes');
  assert((await toggleClicks(page)) === 1, 'showRightView clicks an inactive toggle exactly once');
  await waitShown(page, 'changes', 'showRightView to another view');
  s = await waitSettings(app, (x) => x.rightPaneTab === 'changes');
  assert(s?.rightPaneTab === 'changes', 'the helper is an explicit pick too');
  log('showRightView: idempotent, waits for a mounting panel, one click to switch ✓');

  // ── 5. Imperative opens are transient ─────────────────────────────────────
  await changes.click();
  await waitShown(page, null, 'closing the panel before Mod+Shift+F');
  s = await waitSettings(app, (x) => x.explorerCollapsed === true);
  assert(s?.explorerCollapsed === true, 'closing the panel persists explorerCollapsed');
  await blur(page);
  await page.keyboard.press('Control+Shift+F');
  await waitShown(page, 'files', 'Mod+Shift+F on a closed panel');
  const focused = await page
    .waitForFunction(
      () => document.activeElement?.matches?.('.search__inputbox textarea') === true,
      null,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    focused,
    `Mod+Shift+F focuses the search input (active element: ${await page.evaluate(
      () => document.activeElement?.outerHTML.slice(0, 80) ?? 'none',
    )})`,
  );
  s = await waitSettings(app, (x) => x.explorerCollapsed === false);
  assert(s?.explorerCollapsed === false, 'an imperative open persists the panel as open');
  assert(
    s?.rightPaneTab === 'changes',
    `Mod+Shift+F's Files view is transient: rightPaneTab stays changes (got ${s?.rightPaneTab})`,
  );

  await reloadApp(page);
  await waitShown(page, 'changes', 'reload after a transient Files view');
  log('Mod+Shift+F opens Files + focuses search; the remembered view survives a reload ✓');

  // Opening a file follows into Files (reveal in tree), as a transient view of an open panel.
  await page.waitForSelector('.changes__header', { state: 'visible', timeout: 15000 });
  await blur(page);
  await page.keyboard.press('Control+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill('clean.md');
  const fileRow = page
    .locator('.palette__row')
    .filter({ has: page.locator('.palette__title', { hasText: 'clean.md' }) })
    .first();
  await fileRow.waitFor({ state: 'visible', timeout: 20000 });
  await fileRow.click();
  await page.waitForSelector('.palette', { state: 'hidden', timeout: 5000 });
  await waitShown(page, 'files', 'opening a file reveals it in Files');
  s = await readSettings(app);
  assert(
    s?.rightPaneTab === 'changes',
    `the reveal's Files view is transient: rightPaneTab stays changes (got ${s?.rightPaneTab})`,
  );
  log('reveal-in-tree switches to Files without overwriting the remembered view ✓');

  // ── 6. Closed state persists across reload ────────────────────────────────
  await toggle(page, 'files').click();
  await waitShown(page, null, 'closing from the transient Files view');
  s = await waitSettings(app, (x) => x.explorerCollapsed === true);
  assert(s?.explorerCollapsed === true, 'closing persists explorerCollapsed');
  await reloadApp(page);
  await waitShown(page, null, 'reload with the panel closed');
  assert((await shownRightView(page)) === null, 'shownRightView reports a closed panel as null');
  await changes.click();
  await waitShown(page, 'changes', 'reopening after reload');
  log('explorerCollapsed persists both ways across reload ✓');

  // ── 7. Palette routes ─────────────────────────────────────────────────────
  await runCommand(page, 'Open feature board');
  await page.waitForSelector('.board', { state: 'visible', timeout: 15000 });
  await runCommand(page, 'Open architecture canvas');
  await page.waitForSelector('.arch', { state: 'visible', timeout: 15000 });
  assert((await page.locator('.board').count()) === 0, 'the canvas replaces the board');
  await runCommand(page, 'Open editor');
  await page.waitForFunction(() => !document.querySelector('.board, .arch'), null, {
    timeout: 10000,
  });
  assert(await page.locator('main.centerpane').isVisible(), 'Open editor returns to the workspace');
  await waitShown(page, 'changes', 'the panel after the center views');
  log('palette: board, canvas, back to workspace ✓');

  // ── 8. Moving the panel ───────────────────────────────────────────────────
  assert(
    (await page.locator('#right-pane .rightpane__grip').count()) === 0,
    'the right panel has no dedicated move grip',
  );
  const sideOfCenter = () =>
    page.evaluate(() => {
      const p = document.querySelector('#right-pane')?.getBoundingClientRect();
      const c = document.querySelector('main.centerpane')?.getBoundingClientRect();
      if (!p || !c) return null;
      return p.right <= c.left + 1 ? 'left' : p.left >= c.right - 1 ? 'right' : 'overlap';
    });
  assert((await sideOfCenter()) === 'right', 'the panel starts right of the center');
  // The title band names the view and is the move-drag surface, like the sidebar's Spaces band.
  const head = page.locator('#right-pane > .panel-head');
  assert(
    (await head.locator('.panel-title').textContent()) === 'Changes',
    'the title band names the shown view',
  );
  assert((await head.getAttribute('draggable')) === 'true', 'the title band is a drag surface');
  await head.dragTo(page.locator('main.centerpane'));
  s = await waitSettings(app, (x) => x.layout !== 'sessions,center,explorer');
  assert(
    s && (await sideOfCenter()) !== 'right',
    `dragging the title band onto the center re-docks the panel (layout ${s?.layout})`,
  );
  await head.dragTo(page.locator('main.centerpane'));
  s = await waitSettings(app, (x) => x.layout === 'sessions,center,explorer');
  assert(
    s && (await sideOfCenter()) === 'right',
    `dragging it back restores the default dock (layout ${s?.layout})`,
  );
  log('title band re-docks the panel both ways ✓');
  // The panel root keeps keyboard access to its move menu after the grip is removed.
  const panelRoot = page.locator('#right-pane');
  await panelRoot.focus();
  await panelRoot.press('Shift+F10');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const labels = await page
    .locator('.ctxmenu .ctxmenu__label')
    .evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  const moveItem = labels.find((l) => /\bmove\b/i.test(l));
  assert(
    moveItem,
    `the keyboard panel context menu offers a move action (spec §7); items: ${JSON.stringify(labels)}`,
  );
  await page.locator('.ctxmenu .ctxmenu__item', { hasText: moveItem }).first().click();
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  s = await waitSettings(app, (x) => x.layout !== 'sessions,center,explorer');
  assert(
    s && s.layout !== 'sessions,center,explorer' && (await sideOfCenter()) !== 'right',
    `"${moveItem}" moves the panel (layout ${s?.layout}, side ${await sideOfCenter()})`,
  );
  log(`keyboard context menu "${moveItem}" moves the panel ✓`);
});

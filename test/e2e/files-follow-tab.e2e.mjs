/**
 * files-follow-tab — the Files tree follows the focused editor tab: it highlights that file,
 * expands its collapsed ancestors and scrolls it into view, without switching the right pane or
 * moving focus/selection (docs/specs/2026-09-28-changes-active-highlight.md §14; plan Slice 2
 * AC-F1…F10). Real-app: the tree is windowed over one shared scroller and loaded by readDir.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changeRow,
  commitBase,
  installTabHelpers,
  openChangesPanel,
  tabTitles,
  waitActiveTab,
} from './changes-fixture.mjs';
import { assert, openSession, runScenario, waitForRepoGit } from './harness.mjs';
import { clickTerminalTab } from './nav-history-fixture.mjs';

const FILLER = Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-fft-'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  for (const f of ['a.txt', 'b.txt', 'zz.txt', ...FILLER]) writeFileSync(join(root, f), `${f}\n`);
  writeFileSync(join(root, 'src', 'deep', 'x.ts'), 'export const x = 1;\n');
  commitBase(root);
  writeFileSync(join(root, 'b.txt'), 'b changed\n');
  return root;
}

const SCROLLER = '.rightpane__scroll--files';

const fileRow = (page, name) =>
  page
    .locator('.filerow', {
      has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
    })
    .first();

const revealedNames = (page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll('.filerow--revealed'),
      (e) => e.querySelector('.filerow__name')?.textContent ?? null,
    ),
  );

async function expectRevealed(page, want, what) {
  const deadline = Date.now() + 10000;
  let got = [];
  while (Date.now() < deadline) {
    got = await revealedNames(page);
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await page.waitForTimeout(150);
  }
  assert(false, `${what}: revealed rows ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function waitRevealedInView(page, what) {
  const ok = await page
    .waitForFunction(
      (sel) => {
        const sc = document.querySelector(sel);
        const row = document.querySelector('.filerow--revealed');
        if (!sc || !row) return false;
        const a = sc.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
      },
      SCROLLER,
      { timeout: 8000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert(ok, `${what}: the revealed row is not inside the Files scroller's visible rect`);
}

const expandedOf = (page, name) =>
  page.evaluate((n) => {
    const row = Array.from(document.querySelectorAll('.filerow')).find(
      (r) => r.querySelector('.filerow__name')?.textContent === n,
    );
    return row?.getAttribute('aria-expanded') ?? null;
  }, name);

async function activateTab(page, title) {
  const i = (await tabTitles(page)).indexOf(title);
  assert(i >= 0, `no tab titled "${title}" (tabs: ${JSON.stringify(await tabTitles(page))})`);
  await page.locator('.tabbar [role="tab"]').nth(i).click();
  await waitActiveTab(page, title);
}

const rtabActive = (page) =>
  page.evaluate(() => document.querySelector('.rtab--active')?.textContent?.trim() ?? '');

async function showFiles(page) {
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.files__bar', { state: 'visible', timeout: 15000 });
}

/** Scroll the Files scroller until `name`'s row mounts (the tree is windowed). */
async function scrollToRow(page, name) {
  for (let i = 0; i < 40; i++) {
    if ((await fileRow(page, name).count()) > 0) break;
    await page.evaluate((sel) => {
      const sc = document.querySelector(sel);
      if (sc) sc.scrollTop += sc.clientHeight / 2;
    }, SCROLLER);
    await page.waitForTimeout(100);
  }
  await fileRow(page, name).scrollIntoViewIfNeeded();
}

async function openFromTree(page, name) {
  await scrollToRow(page, name);
  await fileRow(page, name).dblclick();
  await waitActiveTab(page, name);
}

const setScrollTop = (page, top) =>
  page.evaluate(
    ([sel, t]) => {
      const sc = document.querySelector(sel);
      if (sc) sc.scrollTop = t;
    },
    [SCROLLER, top],
  );

const scrollTopOf = (page) =>
  page.evaluate((sel) => document.querySelector(sel)?.scrollTop ?? -1, SCROLLER);

const treeState = (page) =>
  page.evaluate(() => ({
    selected: Array.from(document.querySelectorAll('.filerow--selected'), (e) => e.dataset.path),
    roving: document.querySelector('.filerow[tabindex="0"]')?.dataset.path ?? null,
    focusInPane: !!document.activeElement?.closest('.rightpane'),
  }));

runScenario('files-follow-tab', async ({ page, log }) => {
  const root = makeRepo();
  await installTabHelpers(page);
  await openSession(page, { path: root });
  await waitForRepoGit(page);
  await showFiles(page);
  await fileRow(page, 'src').waitFor({ state: 'visible', timeout: 20000 });
  const sectionLabel = (
    await page.locator('.files__collapse').first().getAttribute('aria-label')
  ).replace(/^Collapse /, '');

  // ── F10: a tree double-click open highlights the file ─────────────────────────
  await fileRow(page, 'src').click();
  await fileRow(page, 'deep').waitFor({ state: 'visible', timeout: 10000 });
  await fileRow(page, 'deep').click();
  await fileRow(page, 'x.ts').waitFor({ state: 'visible', timeout: 10000 });
  await openFromTree(page, 'x.ts');
  await expectRevealed(page, ['x.ts'], 'F10 double-click x.ts');
  await openFromTree(page, 'a.txt');
  await expectRevealed(page, ['a.txt'], 'F10 double-click a.txt');
  await openFromTree(page, 'zz.txt');
  await expectRevealed(page, ['zz.txt'], 'F10 double-click zz.txt');
  log('F10: tree double-click opens are revealed ✓');

  // ── F1: tab click and Ctrl+PageDown move the highlight ────────────────────────
  await activateTab(page, 'a.txt');
  await expectRevealed(page, ['a.txt'], 'F1 a.txt tab click');
  await page.locator('.tabbar [role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press('Control+PageDown');
  await page.waitForFunction(() => window.__sd.active() !== 'a.txt', null, { timeout: 8000 });
  const next = await page.evaluate(() => window.__sd.active());
  await expectRevealed(page, [next], `F1 Ctrl+PageDown to "${next}"`);
  log(`F1: tab click and Ctrl+PageDown (→ ${next}) each reveal exactly that file ✓`);

  // ── F2: collapsed ancestors are expanded and the row scrolled into view ───────
  await activateTab(page, 'a.txt');
  await setScrollTop(page, 0);
  await fileRow(page, 'src').click();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.filerow')).some(
        (r) =>
          r.querySelector('.filerow__name')?.textContent === 'src' &&
          r.getAttribute('aria-expanded') === 'false',
      ),
    null,
    { timeout: 5000 },
  );
  await activateTab(page, 'x.ts');
  await expectRevealed(page, ['x.ts'], 'F2 x.ts under a collapsed src');
  assert((await expandedOf(page, 'src')) === 'true', 'F2: src must be expanded');
  assert((await expandedOf(page, 'deep')) === 'true', 'F2: deep must be expanded');
  await waitRevealedInView(page, 'F2');
  log('F2: ancestors expanded, row in view ✓');

  // ── F4: activation never moves focus, selection or the roving row ─────────────
  // Both files sit near the top, so the selected `src` row stays mounted in the windowed tree
  // and a DOM read of the selection means what it says.
  await activateTab(page, 'a.txt');
  const before = await treeState(page);
  assert(!before.focusInPane, 'F4 precondition: focus is on the tab bar');
  assert(before.selected.length > 0, 'F4 precondition: a row is selected');
  await activateTab(page, 'x.ts');
  await expectRevealed(page, ['x.ts'], 'F4 x.ts tab');
  const after = await treeState(page);
  assert(!after.focusInPane, 'F4: focus moved into the right pane');
  assert(
    JSON.stringify(after.selected) === JSON.stringify(before.selected),
    `F4: selection changed ${JSON.stringify(before.selected)} → ${JSON.stringify(after.selected)}`,
  );
  assert(after.roving === before.roving, `F4: roving row ${before.roving} → ${after.roving}`);
  log('F4: focus, selection and roving row untouched ✓');

  // ── F7: a refresh with the same target does not scroll ────────────────────────
  await activateTab(page, 'zz.txt');
  await expectRevealed(page, ['zz.txt'], 'F7 zz.txt tab');
  await waitRevealedInView(page, 'F7 precondition');
  await setScrollTop(page, 0);
  await page.locator(`.files__bar button[aria-label="Refresh ${sectionLabel}"]`).click();
  await page.waitForTimeout(1500);
  assert((await scrollTopOf(page)) === 0, 'F7: a refresh with the same target scrolled the tree');
  await expectRevealed(page, ['zz.txt'], 'F7 after refresh');
  log('F7: refresh keeps scrollTop ✓');

  // ── F5: a tab that maps to no file clears the highlight ───────────────────────
  await clickTerminalTab(page);
  await expectRevealed(page, [], 'F5 Terminal tab');
  log('F5: Terminal tab → no revealed row ✓');

  // ── F3 + F6: activation keeps the pane on Changes; mounting Files reveals ─────
  await openChangesPanel(page);
  await activateTab(page, 'zz.txt');
  assert((await rtabActive(page)).startsWith('Changes'), 'F3: the pane left Changes');
  await showFiles(page);
  await expectRevealed(page, ['zz.txt'], 'F6 Files remount');
  await waitRevealedInView(page, 'F6');
  log('F3: pane stays on Changes; F6: Files mount reveals and scrolls ✓');

  // A diff tab (from Changes) is followed too.
  await openChangesPanel(page);
  await (await changeRow(page, 'Changes', 'b.txt')).click();
  await waitActiveTab(page, 'b.txt (Working Tree)');
  await showFiles(page);
  await expectRevealed(page, ['b.txt'], 'b.txt diff tab');
  log('a diff tab reveals its file ✓');

  // ── F8: a section collapsed via its bar stays collapsed ───────────────────────
  await page.locator(`.files__bar button[aria-label="Collapse ${sectionLabel}"]`).click();
  await page
    .locator(`.files__bar button[aria-label="Expand ${sectionLabel}"]`)
    .waitFor({ state: 'visible', timeout: 5000 });
  await activateTab(page, 'x.ts');
  await page.waitForTimeout(800);
  assert(
    (await page.locator(`.files__bar button[aria-label="Expand ${sectionLabel}"]`).count()) === 1,
    'F8: activating a tab expanded a collapsed section',
  );
  await expectRevealed(page, [], 'F8 collapsed section');
  await page.locator(`.files__bar button[aria-label="Expand ${sectionLabel}"]`).click();
  await expectRevealed(page, ['x.ts'], 'F8 after expanding the section');
  log('F8: collapsed section stays collapsed; expanding reveals ✓');

  // ── F9: an active search query survives a tab activation ──────────────────────
  const input = page.locator('.search__inputbox textarea');
  await input.click();
  await input.fill('zz');
  await activateTab(page, 'a.txt');
  await page.waitForTimeout(500);
  assert((await input.inputValue()) === 'zz', 'F9: activating a tab cleared the search query');
  await input.fill('');
  await expectRevealed(page, ['a.txt'], 'F9 after clearing the search');
  log('F9: search query kept ✓');
});

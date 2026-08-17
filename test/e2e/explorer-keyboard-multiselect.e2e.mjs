/**
 * Explorer keyboard multi-select (real-app smoke).
 *
 * Drives the Files tree with REAL keystrokes against a throwaway project of flat files and
 * asserts the gesture table of docs/specs/2026-08-17-explorer-keyboard-multiselect.md §2:
 *   Shift+ArrowDown ×2 → 3 selected; Shift+ArrowUp → 2 (the run SHRINKS, it does not invert);
 *   Ctrl+A → every row; Ctrl+ArrowDown → still every row but the roving focus moved;
 *   Ctrl+Space → the focused row toggles out.
 *
 * The payoff assertion is the last one: right-clicking a row of a selection built ONLY from the
 * keyboard reads `Delete N items`, i.e. the selection-aware context menu is finally reachable
 * without a pointer — the P1 gap in docs/runs/2026-08-16-selection-context-menus/blockers.md.
 * Nothing is deleted; Escape closes the menu.
 *
 * Counts are read from BOTH `.filerow--selected` and `[aria-selected="true"]`, as
 * explorer-multiselect.e2e.mjs does, so the visual class and the a11y state are verified together.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** The rendered menu rows in order: {label, danger, disabled}. */
const menuRows = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map((wrap) => {
      const item = wrap.querySelector('.ctxmenu__item');
      return {
        label: item?.querySelector('span:last-child')?.textContent?.trim() ?? '',
        danger: !!item?.classList.contains('ctxmenu__item--danger'),
        disabled: !!item?.disabled,
      };
    });
  });

runScenario('explorer-keyboard-multiselect', async ({ page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-kmsel-'));
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
  for (const n of names) writeFileSync(join(dir, n), `${n}\n`);

  await openSession(page, { path: dir });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await fileRow(page, 'a.txt').first().waitFor({ state: 'attached', timeout: 20000 });
  log('temp project opened with a–e.txt ✓');

  const expectCount = async (n, label) => {
    const ok = await page
      .waitForFunction(
        (want) =>
          document.querySelectorAll('.filerow--selected').length === want &&
          document.querySelectorAll('.filerow[aria-selected="true"]').length === want,
        n,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    const cls = await page.locator('.filerow--selected').count();
    const aria = await page.locator('.filerow[aria-selected="true"]').count();
    assert(ok, `${label}: expected ${n} selected (class=${cls}, aria=${aria})`);
    log(`${label}: ${n} selected ✓`);
  };

  /** The row that currently owns keyboard focus, by base name. */
  const focusedRow = () =>
    page.evaluate(() => {
      const el = document.activeElement?.closest?.('.filerow');
      return el?.querySelector('.filerow__name')?.textContent ?? null;
    });

  const expectFocus = async (name, label) => {
    const ok = await page
      .waitForFunction(
        (want) => {
          const el = document.activeElement?.closest?.('.filerow');
          return el?.querySelector('.filerow__name')?.textContent === want;
        },
        name,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    assert(ok, `${label}: expected focus on ${name} (got ${await focusedRow()})`);
    log(`${label}: focus on ${name} ✓`);
  };

  // Seat the selection + anchor on a.txt with a click, then hand the row real DOM focus so every
  // keystroke below reaches the tree's own key handler (a click lands focus on whatever was
  // focusable at mousedown time, which is not yet the freshly-roving row).
  // Ctrl-click, not a plain click: it seats selection+anchor identically but does NOT open the
  // file, so Monaco never mounts and cannot steal the focus we are about to place (the same
  // precedent as explorer-dnd-polish.e2e.mjs).
  await fileRow(page, 'a.txt')
    .first()
    .click({ modifiers: ['Control'] });
  await expectCount(1, 'Ctrl-click a.txt');
  await page.locator('.filerow[tabindex="0"]').first().focus();
  await expectFocus('a.txt', 'seated keyboard focus');

  // ── Shift+Arrow ranges from a FIXED anchor ─────────────────────────────────
  await page.keyboard.press('Shift+ArrowDown');
  await expectCount(2, 'Shift+ArrowDown (a–b)');
  await page.keyboard.press('Shift+ArrowDown');
  await expectCount(3, 'Shift+ArrowDown again (a–c)');
  await expectFocus('c.txt', 'range head');

  // Reversing must SHRINK the run back toward the anchor, not invert it about the moving end.
  await page.keyboard.press('Shift+ArrowUp');
  await expectCount(2, 'Shift+ArrowUp shrinks the run (a–b)');
  await expectFocus('b.txt', 'range head after reversing');

  // ── Ctrl+A selects every visible row, focus unchanged ──────────────────────
  await page.keyboard.press('Control+a');
  await expectCount(names.length, 'Ctrl+A');
  await expectFocus('b.txt', 'Ctrl+A leaves focus alone');

  // ── Ctrl+Arrow moves focus WITHOUT touching the selection ──────────────────
  await page.keyboard.press('Control+ArrowDown');
  await expectFocus('c.txt', 'Ctrl+ArrowDown moved the roving row');
  await expectCount(names.length, 'Ctrl+ArrowDown left the selection alone');

  // ── Ctrl+Space toggles the focused row out ─────────────────────────────────
  await page.keyboard.press('Control+Space');
  await expectCount(names.length - 1, 'Ctrl+Space toggled c.txt out');
  const stillSelected = await page.evaluate(() => {
    const rows = document.querySelectorAll('.filerow--selected');
    return Array.from(rows).map((r) => r.querySelector('.filerow__name')?.textContent);
  });
  assert(
    !stillSelected.includes('c.txt'),
    `Ctrl+Space should have removed the FOCUSED row (still selected: ${JSON.stringify(stillSelected)})`,
  );
  await expectFocus('c.txt', 'Ctrl+Space leaves focus alone');

  // ── The payoff: a keyboard-built selection reaches the selection-aware menu ─
  await fileRow(page, 'a.txt').first().click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(120);
  await expectCount(names.length - 1, 'selection preserved under the open menu');

  const rows = await menuRows(page);
  log('menu:', JSON.stringify(rows.map((r) => r.label)));
  const last = rows[rows.length - 1];
  assert(
    last.label === `Delete ${names.length - 1} items`,
    `a keyboard-built selection must scope the menu (expected "Delete ${names.length - 1} items", got "${last.label}")`,
  );
  assert(last.danger, 'the destructive item must carry the danger class');
  const rename = rows.find((r) => r.label === 'Rename…');
  assert(rename?.disabled, 'Rename… must be disabled while several items are targeted');
  log('keyboard-built selection reaches the selection-aware menu ✓');

  // Close the menu without activating anything — this scenario deletes nothing.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  log('menu dismissed, nothing deleted ✓');
});

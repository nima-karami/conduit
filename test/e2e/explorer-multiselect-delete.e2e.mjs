/**
 * Bulk delete from the Explorer context menu (real-app smoke).
 *
 * Covers the selection-aware-context-menus spec §14 C: right-clicking a row INSIDE a
 * multi-selection preserves it and scopes Delete to every selected file; right-clicking a row
 * OUTSIDE the selection collapses onto that row. Filesystem assertions run in this process (not
 * the renderer), and `shell.trashItem` is spied so the "loop over the single-path IPC" contract
 * is pinned independently of the disk state.
 *
 * The confirm is the in-app renderer dialog (`.confirm`) — a native dialog would be invisible
 * here and would hang the harness.
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, getSpyCalls, openSession, runScenario, spyMain } from './harness.mjs';

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** The rendered menu rows in order: {label, danger, sepBefore, disabled}. */
const menuRows = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map((wrap) => {
      const item = wrap.querySelector('.ctxmenu__item');
      return {
        label: item?.querySelector('span:last-child')?.textContent?.trim() ?? '',
        danger: !!item?.classList.contains('ctxmenu__item--danger'),
        sepBefore: !!wrap.querySelector('.ctxmenu__sep'),
        disabled: !!item?.disabled,
      };
    });
  });

runScenario('explorer-multiselect-delete', async ({ app, page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-mdel-'));
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
  for (const n of names) writeFileSync(join(dir, n), `${n}\n`);
  const abs = (n) => join(dir, n);

  await spyMain(app, [{ api: 'trashItem' }]);
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

  /** Poll the REAL filesystem — the delete is async all the way through the host. */
  const waitGone = async (name) => {
    for (let i = 0; i < 60; i++) {
      if (!existsSync(abs(name))) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  // ── Delete a 3-file selection from the menu ────────────────────────────────
  await fileRow(page, 'a.txt').first().click();
  await fileRow(page, 'b.txt')
    .first()
    .click({ modifiers: ['Control'] });
  await fileRow(page, 'c.txt')
    .first()
    .click({ modifiers: ['Control'] });
  await expectCount(3, 'a+b+c selected');

  await fileRow(page, 'c.txt').first().click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(120);
  await expectCount(3, 'selection preserved under the open menu');

  const rows = await menuRows(page);
  log('menu:', JSON.stringify(rows.map((r) => r.label)));
  const last = rows[rows.length - 1];
  assert(
    last.label === 'Delete 3 items',
    `last item should read "Delete 3 items" (got ${last.label})`,
  );
  assert(last.danger, 'the destructive item must carry the danger class');
  assert(last.sepBefore, 'the destructive item must be separated from the group above');
  const rename = rows.find((r) => r.label === 'Rename…');
  assert(rename?.disabled, 'Rename… must be disabled while 3 items are targeted');

  await page.locator('.ctxmenu__item--danger').last().click();
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 8000 });
  const msg = await page.locator('.confirm__msg').innerText();
  log('confirm:', JSON.stringify(msg));
  assert(/3 items/.test(msg), `confirm should count the items (got ${JSON.stringify(msg)})`);
  assert(/a\.txt/.test(msg) && /c\.txt/.test(msg), 'confirm should list the base names');
  const cancelFocused = await page
    .waitForFunction(() => document.activeElement?.textContent?.trim() === 'Cancel', undefined, {
      timeout: 3000,
    })
    .then(() => true)
    .catch(() => false);
  assert(cancelFocused, 'a bulk destructive confirm must open with Cancel focused');

  await page.locator('.confirm .btn--danger').click();
  for (const n of ['a.txt', 'b.txt', 'c.txt']) {
    assert(await waitGone(n), `${n} should be gone from disk`);
  }
  assert(existsSync(abs('d.txt')) && existsSync(abs('e.txt')), 'd.txt and e.txt must survive');
  log('a/b/c deleted, d/e untouched ✓');

  const trashed = (await getSpyCalls(app))
    .filter((c) => c.api === 'trashItem')
    .map((c) => String(c.args[0]));
  assert(
    trashed.length === 3,
    `trashItem should be called once per target (got ${trashed.length}: ${JSON.stringify(trashed)})`,
  );
  for (const n of ['a.txt', 'b.txt', 'c.txt']) {
    assert(
      trashed.some((p) => p.replace(/\\/g, '/').endsWith(`/${n}`)),
      `trashItem should have been called for ${n} (got ${JSON.stringify(trashed)})`,
    );
  }
  log('trashItem called once per target ✓');

  // ── Right-clicking outside the selection collapses onto that row ───────────
  await fileRow(page, 'a.txt').first().waitFor({ state: 'detached', timeout: 15000 });
  await fileRow(page, 'd.txt').first().click();
  await expectCount(1, 'd.txt selected');

  await fileRow(page, 'e.txt').first().click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(120);
  await expectCount(1, 'selection collapsed onto the clicked row');
  const rows2 = await menuRows(page);
  assert(
    rows2[rows2.length - 1].label === 'Delete',
    `a single target must read "Delete" (got ${rows2[rows2.length - 1].label})`,
  );

  await page.locator('.ctxmenu__item--danger').last().click();
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 8000 });
  await page.locator('.confirm .btn--danger').click();
  assert(await waitGone('e.txt'), 'e.txt should be gone from disk');
  assert(existsSync(abs('d.txt')), 'd.txt must survive — it was never the menu target');
  log('collapse leg: only the right-clicked row was deleted ✓');
});

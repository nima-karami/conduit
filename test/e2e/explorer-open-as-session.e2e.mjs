/**
 * Explorer "Open as new session" (real-app smoke).
 *
 * A folder row offers the item, a file row does not, a two-folder selection greys it out with a
 * reason, and activating it opens the New Session flow prefilled with that folder as the working
 * directory — which is what the modal must be able to show for a path that is not a known repo.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const ITEM = 'Open as new session';

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** The rendered menu rows in order: {label, disabled, title}. The tooltip hangs off the row
 *  wrapper, not the button — a disabled button never shows a title of its own. */
const menuRows = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map((wrap) => {
      const item = wrap.querySelector('.ctxmenu__item');
      return {
        label: item?.querySelector('span:last-child')?.textContent?.trim() ?? '',
        disabled: !!item?.disabled,
        title: wrap.getAttribute('title') ?? '',
      };
    });
  });

// Windows hands back either separator and either drive-letter case depending on the path's
// origin, and the dialog bookends the path with LRMs so it truncates from the left — the
// assertion is about WHICH folder, not how it was spelled.
const norm = (p) =>
  p
    .replace(/[\u200e\s]/g, '')
    .replace(/\\/g, '/')
    .toLowerCase();

const openMenuOn = async (page, name) => {
  await fileRow(page, name).first().click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  return menuRows(page);
};

// Escape closes the menu but ALSO clears the tree's selection, so it has to happen before a
// selection is built, never between building one and right-clicking it.
const closeMenu = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 8000 });
};

runScenario('explorer-open-as-session', async ({ page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-oas-'));
  mkdirSync(join(dir, 'pkg'));
  mkdirSync(join(dir, 'pkg2'));
  writeFileSync(join(dir, 'pkg', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'top.txt'), 'top\n');

  await openSession(page, { path: dir });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await fileRow(page, 'pkg').first().waitFor({ state: 'attached', timeout: 20000 });
  log('temp project opened ✓');

  const fileRows = await openMenuOn(page, 'top.txt');
  log('file menu:', JSON.stringify(fileRows.map((r) => r.label)));
  assert(!fileRows.some((r) => r.label === ITEM), `a file row must not offer "${ITEM}"`);

  await closeMenu(page);
  await fileRow(page, 'pkg').first().click();
  await fileRow(page, 'pkg2')
    .first()
    .click({ modifiers: ['Control'] });
  const twoRows = await openMenuOn(page, 'pkg2');
  const two = twoRows.find((r) => r.label === ITEM);
  assert(two, `two selected folders must still show "${ITEM}"`);
  assert(two.disabled, 'it must be disabled while two folders are targeted');
  assert(
    /single folder/i.test(two.title),
    `the disabled row must say why (got ${JSON.stringify(two.title)})`,
  );
  log('two folders → disabled with a reason ✓');

  await closeMenu(page);
  await fileRow(page, 'pkg').first().click();
  const rows = await openMenuOn(page, 'pkg');
  const labels = rows.map((r) => r.label);
  log('folder menu:', JSON.stringify(labels));
  const i = labels.indexOf(ITEM);
  assert(i >= 0, `a folder row must offer "${ITEM}" (got ${labels.join(', ')})`);
  assert(!rows[i].disabled, 'it must be enabled for a single folder');
  assert(
    labels.indexOf('Reveal in Explorer') < i && i < labels.indexOf('Delete'),
    'the item belongs after the reveal-style items and before the destructive one',
  );

  await page.locator('.ctxmenu__item').filter({ hasText: ITEM }).first().click();

  await page.waitForSelector('.modal .modal__title', { state: 'visible', timeout: 8000 });
  const title = (await page.locator('.modal .modal__title').innerText()).trim();
  assert(title === 'New session', `the New Session dialog should open (got ${title})`);

  const shown = await page.locator('.repo--active .repo__path').first().innerText();
  log('prefilled path:', JSON.stringify(shown));
  assert(
    norm(shown) === norm(join(dir, 'pkg')),
    `the dialog should preselect the folder (got ${shown}, want ${join(dir, 'pkg')})`,
  );
  log('New Session prefilled with the clicked folder ✓');
});

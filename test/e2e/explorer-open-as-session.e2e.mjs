/**
 * Explorer "Open as new session" (real-app smoke).
 *
 * A folder row offers the item, a file row does not, and activating it opens the New Session
 * flow prefilled with that folder as the working directory — which is what the modal must be
 * able to show for a path that is not a known repo.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** The rendered menu labels, in order. */
const menuLabels = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map(
      (wrap) => wrap.querySelector('.ctxmenu__item span:last-child')?.textContent?.trim() ?? '',
    );
  });

// Windows hands back either separator and either drive-letter case depending on the path's
// origin, and the dialog bookends the path with LRMs so it truncates from the left — the
// assertion is about WHICH folder, not how it was spelled.
const norm = (p) => p.replace(/[‎\s]/g, '').replace(/\\/g, '/').toLowerCase();

const openMenuOn = async (page, name) => {
  await page.keyboard.press('Escape');
  await fileRow(page, name).first().click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  return menuLabels(page);
};

runScenario('explorer-open-as-session', async ({ page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-oas-'));
  mkdirSync(join(dir, 'pkg'));
  writeFileSync(join(dir, 'pkg', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'top.txt'), 'top\n');

  await openSession(page, { path: dir });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await fileRow(page, 'pkg').first().waitFor({ state: 'attached', timeout: 20000 });
  log('temp project opened ✓');

  const fileLabels = await openMenuOn(page, 'top.txt');
  log('file menu:', JSON.stringify(fileLabels));
  assert(
    !fileLabels.includes('Open as new session'),
    'a file row must not offer "Open as new session"',
  );

  const dirLabels = await openMenuOn(page, 'pkg');
  log('folder menu:', JSON.stringify(dirLabels));
  const i = dirLabels.indexOf('Open as new session');
  assert(i >= 0, `a folder row must offer "Open as new session" (got ${dirLabels.join(', ')})`);
  assert(
    dirLabels.indexOf('Reveal in Explorer') < i && i < dirLabels.indexOf('Delete'),
    'the item belongs after the reveal-style items and before the destructive one',
  );

  await page.locator('.ctxmenu__item').filter({ hasText: 'Open as new session' }).first().click();

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

/**
 * Explorer multi-select (real-app smoke).
 *
 * Drives the Files tree against a throwaway project of flat files and asserts that the
 * pointer gestures produce the right selected-row counts:
 *   plain click → 1, Ctrl-click another → 2, Ctrl-click it again → 1,
 *   Shift-click across a range → the contiguous count, plain click → back to 1.
 *
 * Counts are read from BOTH `.filerow--selected` and `[aria-selected="true"]` so the visual
 * class and the a11y state are verified together. See docs/specs/2026-06-27-explorer-multiselect.md.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

runScenario('explorer-multiselect', async ({ page, log }) => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-msel-'));
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    writeFileSync(join(dir, n), `${n}\n`);
  }

  await openSession(page, { path: dir });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await fileRow(page, 'a.txt').first().waitFor({ state: 'attached', timeout: 20000 });
  log('temp project opened with a–e.txt ✓');

  // Wait until both the visual class and the aria-state report exactly `n` selected rows; on
  // failure surface what each reported so a class/aria divergence is obvious.
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
    log(`${label}: ${n} selected (class=${cls}, aria=${aria}) ✓`);
  };

  // aria-multiselectable on the container (MVP a11y).
  const multiselectable = await page
    .locator('.right__scroll--files[aria-multiselectable="true"]')
    .count();
  assert(
    multiselectable === 1,
    `tree container should be aria-multiselectable (got ${multiselectable})`,
  );

  await fileRow(page, 'a.txt').first().click();
  await expectCount(1, 'plain click a.txt');

  await fileRow(page, 'c.txt')
    .first()
    .click({ modifiers: ['Control'] });
  await expectCount(2, 'Ctrl-click c.txt');

  await fileRow(page, 'c.txt')
    .first()
    .click({ modifiers: ['Control'] });
  await expectCount(1, 'Ctrl-click c.txt again (toggle off)');

  // Re-seat the anchor on a.txt, then Shift-click d.txt → contiguous a..d = 4.
  await fileRow(page, 'a.txt').first().click();
  await expectCount(1, 're-seat anchor on a.txt');
  await fileRow(page, 'd.txt')
    .first()
    .click({ modifiers: ['Shift'] });
  await expectCount(4, 'Shift-click d.txt (range a–d)');

  await fileRow(page, 'e.txt').first().click();
  await expectCount(1, 'plain click e.txt (collapse to one)');
});

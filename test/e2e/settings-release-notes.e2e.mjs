/**
 * settings-release-notes — Settings → Release notes reads the bundled CHANGELOG.md through the
 * host: it opens on the installed version, arrow keys move between versions, and both the About
 * row and the What's-new dialog land on it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, profileDir, runScenario } from './harness.mjs';

const currentVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

// A settings file with no lastSeenVersion is a legacy profile: the post-update toast offers the
// installed version's notes, which is the What's-new entry point checked last.
const userDataDir = profileDir('settings-release-notes');
writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, settings: {} }));

const selectedVersion = (page) =>
  page
    .locator('.relnotes__rail [role="option"][aria-selected="true"] .relnotes__vername')
    .textContent();
const shownVersion = (page) =>
  page.locator('[data-release-version]').getAttribute('data-release-version');

async function waitShown(page, version) {
  await page.waitForFunction(
    (v) =>
      document.querySelector('[data-release-version]')?.getAttribute('data-release-version') === v,
    version,
    { timeout: 5000 },
  );
}

// The control that was activated unmounts, so Settings has to take focus or Tab walks the workbench.
async function assertFocusLanded(page, route) {
  const landed = await page
    .waitForFunction(
      () => {
        const active = document.activeElement;
        return (
          !!document.querySelector('.modal.settings')?.contains(active) &&
          active?.getAttribute('aria-selected') === 'true'
        );
      },
      null,
      { timeout: 5000 },
    )
    .then(
      () => true,
      () => false,
    );
  const where = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));
  assert(landed, `${route}: focus lands on the selected version inside Settings (got ${where})`);
}

async function closeSettings(page) {
  await page.locator('.settings .iconbtn[aria-label="Close settings"]').click();
  await page.locator('.modal.settings').waitFor({ state: 'detached', timeout: 5000 });
}

runScenario(
  'settings-release-notes',
  async ({ page, log }) => {
    // The toast would sit over the footer; take it first so the Settings button is clear.
    const toast = page.locator('[data-post-update-toast]');
    await toast.waitFor({ state: 'visible', timeout: 15000 });

    // 1. Settings → Release notes opens on the installed version and renders its notes.
    await page.locator('.footbtn[title^="Settings"]').click();
    await page.locator('.settings__navitem', { hasText: 'Release notes' }).click();
    await page
      .locator('[data-release-notes="ready"]')
      .waitFor({ state: 'visible', timeout: 10000 });
    await waitShown(page, currentVersion);
    assert(
      (await selectedVersion(page)) === `v${currentVersion}`,
      `the rail selects the installed v${currentVersion}`,
    );
    const installedRow = page.locator('.relnotes__rail [role="option"][aria-selected="true"]');
    assert(
      (await installedRow.textContent())?.includes('Installed'),
      'the installed version carries its tag',
    );
    const body = page.locator('.relnotes__body');
    assert((await body.locator('li').count()) > 0, 'the installed version renders its notes');
    assert(
      (await page.locator('.relnotes__rail [role="option"]').count()) > 50,
      'the rail lists the whole changelog',
    );
    assert(
      (await page.locator('.relnotes__rail').textContent())?.includes('Unreleased') === false,
      'the Unreleased section is not listed',
    );
    log(`opened on v${currentVersion}`);

    // 2. Arrow keys move the selection (and focus) and swap the notes, scrolled to the top.
    const options = page.locator('.relnotes__rail [role="option"]');
    const index = Number(await installedRow.getAttribute('data-index'));
    const nextVersion = (
      await options
        .nth(index + 1)
        .locator('.relnotes__vername')
        .textContent()
    )?.replace(/^v/, '');
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await installedRow.press('ArrowDown');
    await waitShown(page, nextVersion);
    assert(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'),
      'focus follows the selection',
    );
    assert((await body.evaluate((el) => el.scrollTop)) === 0, 'a new version starts at its top');
    assert((await body.locator('li').count()) > 0, `v${nextVersion} renders its notes`);
    await page.keyboard.press('End');
    const last = await options.last().locator('.relnotes__vername').textContent();
    await waitShown(page, last?.replace(/^v/, ''));
    await page.keyboard.press('Home');
    const first = await options.first().locator('.relnotes__vername').textContent();
    await waitShown(page, first?.replace(/^v/, ''));
    await page.keyboard.press('ArrowUp');
    assert((await shownVersion(page)) === first?.replace(/^v/, ''), 'Up at the top stays put');
    log(`arrow keys: v${currentVersion} → v${nextVersion}, End → ${last}, Home → ${first}`);

    // 3. About → Release notes "View all" lands on the page.
    await page.locator('.settings__navitem', { hasText: 'About' }).click();
    await page
      .locator('.about__row', { hasText: 'Release notes' })
      .getByRole('button', { name: 'View all' })
      .click();
    await waitShown(page, currentVersion);
    assert(
      (await page.locator('.settings__navitem--active').textContent()) === 'Release notes',
      'About → View all switches the section to Release notes',
    );
    await assertFocusLanded(page, 'About → View all');
    await closeSettings(page);

    // 4. What's new → "All release notes" closes the dialog and opens Settings on the page.
    await toast.getByRole('button', { name: "What's new" }).click();
    const dialog = page.locator('[role="dialog"][data-whats-new]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByRole('button', { name: 'All release notes' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('.modal.settings').waitFor({ state: 'visible', timeout: 5000 });
    await waitShown(page, currentVersion);
    assert(
      (await page.locator('.settings__navitem--active').textContent()) === 'Release notes',
      "What's new → All release notes opens Settings on Release notes",
    );
    await assertFocusLanded(page, "What's new → All release notes");
    log('About row and What’s-new link both land on Release notes');
  },
  { userDataDir },
);

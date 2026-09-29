/** Shared by the split-editor e2e scenarios: selectors and real-input steps on editor groups. */

import { assert } from './harness.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const G = (g) => `.editor-group[data-group="${g}"]`;
export const groupCount = (page) => page.locator('.editor-group').count();
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function openFromExplorer(page, name) {
  await explorer(page, name, 'dblclick');
  await page.waitForFunction(
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    { timeout: 15000 },
  );
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
}

export const politeText = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.shell > [role="status"][aria-live="polite"]:not(.bg-open-status)')
        ?.textContent ?? '',
  );

export const groupTabs = (page, g) =>
  page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} [role="tab"] span`)].map((e) => e.textContent),
    G(g),
  );

export async function waitPolite(page, text, label) {
  await page
    .waitForFunction(
      (t) =>
        document.querySelector('.shell > [role="status"][aria-live="polite"]:not(.bg-open-status)')
          ?.textContent === t,
      text,
      { timeout: 5000 },
    )
    .catch(async () =>
      assert(false, `${label}: the polite region says ${JSON.stringify(await politeText(page))}`),
    );
}

export const tabOf = (page, g, name) =>
  page.locator(`${G(g)} [role="tab"]`, {
    has: page.locator('span', { hasText: new RegExp(`^${esc(name)}$`) }),
  });

/** The group's shown tab: `.tab--active` in the active group, `.tab--current` in the other. */
export const shownTab = (page, g) =>
  page.evaluate(
    (sel) =>
      document.querySelector(`${sel} .tab--active span, ${sel} .tab--current span`)?.textContent ??
      null,
    G(g),
  );

export const groupState = async (page, g) => ({
  tabs: await groupTabs(page, g),
  shown: await shownTab(page, g),
});

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A real click or double-click on an explorer row (single = preview, double = pinned). */
export async function explorer(page, name, how) {
  await page.click('.rtab:has-text("Files")');
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  if (how === 'dblclick') await row.first().dblclick();
  else await row.first().click();
}

export async function waitShown(page, g, name, label) {
  await page
    .waitForFunction(
      ({ sel, n }) =>
        document.querySelector(`${sel}[data-active="true"] .tab--active span`)?.textContent === n,
      { sel: G(g), n: name },
      { timeout: 15000 },
    )
    .catch(async () =>
      assert(
        false,
        `${label}: group ${g} is not active on ${name} (${JSON.stringify(await groupState(page, g))})`,
      ),
    );
}

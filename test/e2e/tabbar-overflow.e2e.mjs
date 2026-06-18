/**
 * Editor tab strip: a tab's box stays CONSTANT whether or not the strip overflows.
 *
 * Repro of the papercut: the classic ::-webkit-scrollbar is non-overlay in Electron's
 * Chromium, so when the strip overflows its height shaves 6px off the flex content box —
 * an align-items:stretch tab would squish (and grow back when a tab closes clears the
 * overflow). The fix pins `.tab` to the row height so it's invariant to the scrollbar,
 * which is now ultra-thin and overlaid. This scenario opens enough files to overflow,
 * measures a tab's box, closes files until overflow clears, re-measures the SAME-position
 * tab, and asserts width AND height are unchanged.
 *
 * Driven against the REAL app (the Conduit repo is the opened project) so the actual
 * Chromium scrollbar layout is exercised — a mock renderer can't reproduce the gutter.
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

const fileRowByName = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
  });

// Measure a SPECIFIC tab by its data-tabid so the same tab is compared across the
// overflowing and non-overflowing states (closing other tabs must not change ITS box).
const measureTab = (page, tabid) =>
  page.evaluate((id) => {
    const strip = document.querySelector('.tabbar');
    const tab = strip.querySelector(`[data-tabid="${CSS.escape(id)}"]`);
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      overflowing: strip.scrollWidth > strip.clientWidth + 1,
      stripScrollW: strip.scrollWidth,
      stripClientW: strip.clientWidth,
    };
  }, tabid);

const stripOverflowing = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector('.tabbar');
    return strip.scrollWidth > strip.clientWidth + 1;
  });

runScenario('tabbar-overflow', async ({ page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 20000 });

  // Expand webview/ then open many source files from it to overflow the strip.
  await fileRowByName(page, 'webview').first().click();
  await fileRowByName(page, 'app.tsx').first().waitFor({ state: 'attached', timeout: 20000 });

  // Open files one at a time until the strip overflows (cap the attempts so a layout
  // regression that prevents overflow fails loudly instead of looping forever).
  const candidates = [
    'app.tsx',
    'docs.ts',
    'icons.tsx',
    'bridge.ts',
    'dirty-store.ts',
    'save-registry.ts',
    'drag-guard.ts',
    'tab-overflow.ts',
    'monaco-setup.ts',
    'styles.css',
  ];

  let opened = 0;
  for (const name of candidates) {
    const row = fileRowByName(page, name);
    if ((await row.count()) === 0) continue;
    await row.first().click();
    opened += 1;
    await page.waitForTimeout(150);
    if (await stripOverflowing(page)) break;
  }

  // Anchor on the FIRST editor tab (head of the strip) — it stays put as we close
  // later tabs, so its box is the apples-to-apples comparison across both states.
  const anchorId = await page.evaluate(() => {
    const tabs = document.querySelectorAll('.tabbar .tab');
    return tabs[1]?.getAttribute('data-tabid') ?? null;
  });
  assert(anchorId, 'expected at least one editor tab to anchor the measurement');

  const overflowState = await measureTab(page, anchorId);
  assert(
    overflowState?.overflowing,
    `strip should overflow after opening ${opened} files (scrollW=${overflowState?.stripScrollW} clientW=${overflowState?.stripClientW})`,
  );
  log(
    `overflowing: tab box = ${overflowState.width.toFixed(2)}x${overflowState.height.toFixed(2)} ` +
      `(scrollW=${overflowState.stripScrollW} clientW=${overflowState.stripClientW}) ✓`,
  );

  // Close editor tabs from the END (never the anchored head tab) until overflow clears.
  for (let i = 0; i < 20; i++) {
    if (!(await stripOverflowing(page))) break;
    const closeBtns = page.locator('.tab .tab__close');
    const n = await closeBtns.count();
    if (n === 0) break;
    await closeBtns.nth(n - 1).click();
    await page.waitForTimeout(150);
  }

  const flatState = await measureTab(page, anchorId);
  assert(flatState, 'anchored tab must still be open after closing trailing tabs');
  assert(
    !flatState.overflowing,
    `strip should no longer overflow after closing tabs (scrollW=${flatState.stripScrollW} clientW=${flatState.stripClientW})`,
  );
  log(
    `not overflowing: tab box = ${flatState.width.toFixed(2)}x${flatState.height.toFixed(2)} ` +
      `(scrollW=${flatState.stripScrollW} clientW=${flatState.stripClientW}) ✓`,
  );

  // Core invariant: the tab's measured box is identical (≤0.5px) between the two states.
  const dW = Math.abs(overflowState.width - flatState.width);
  const dH = Math.abs(overflowState.height - flatState.height);
  assert(
    dW <= 0.5,
    `tab WIDTH must not change with overflow: ${overflowState.width} vs ${flatState.width} (Δ${dW})`,
  );
  assert(
    dH <= 0.5,
    `tab HEIGHT must not change with overflow: ${overflowState.height} vs ${flatState.height} (Δ${dH}) — ` +
      `the scrollbar is still subtracting from the tab box`,
  );
  log(
    `invariant holds: ΔW=${dW.toFixed(3)}px ΔH=${dH.toFixed(3)}px (scrollbar is overlaid, not a gutter) ✓`,
  );
});

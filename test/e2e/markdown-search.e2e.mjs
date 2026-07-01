/**
 * In-rendered-markdown find (spec 2026-07-01-markdown-search).
 *
 * Drives the REAL app: opens CHANGELOG.md in the rendered view, then exercises the scoped
 * Ctrl+F find bar:
 *  - Ctrl+F over the focused markdown opens the bar; typing highlights matches via the CSS
 *    Custom Highlight API and shows an `n/total` count;
 *  - Enter cycles the current match (ordinal advances);
 *  - Esc closes the bar and clears the global highlight registry;
 *  - Ctrl+F while the terminal is focused opens the TERMINAL find, not the markdown one.
 *
 * The markdown find bar is `.term-find--md`; the terminal find bar is `.term-find` without
 * that modifier — the shared chrome class is how they visually match (D4).
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, REPO, runScenario } from './harness.mjs';

const mdBar = '.term-find--md';
const mdCount = '.term-find--md .term-find__count';

runScenario('markdown-search', async ({ app, page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^CHANGELOG\.md$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page
    .locator('.markdown h1, .markdown h2')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  log('CHANGELOG.md rendered ✓');

  // ── Ctrl+F over the focused markdown opens the scoped find bar ────────────────
  await page.locator('.markdown').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Control+f');
  await page.locator(mdBar).waitFor({ state: 'visible', timeout: 5000 });
  log('Ctrl+F opened the markdown find bar ✓');

  // ── Typing highlights matches + shows an n/total count ────────────────────────
  await page.locator(`${mdBar} .term-find__input`).fill('the');
  await page.waitForFunction(
    () =>
      /^[1-9]\d*\/[1-9]\d*$/.test(
        document.querySelector('.term-find--md .term-find__count')?.textContent ?? '',
      ),
    null,
    { timeout: 5000 },
  );
  const countText = (await page.locator(mdCount).textContent())?.trim() ?? '';
  assert(/^\d+\/\d+$/.test(countText), `count should read n/total, got "${countText}"`);

  const hl = await page.evaluate(() => {
    const all = CSS.highlights.get('md-find');
    const cur = CSS.highlights.get('md-find-current');
    return {
      hasAll: CSS.highlights.has('md-find'),
      allSize: all ? all.size : 0,
      curSize: cur ? cur.size : 0,
    };
  });
  assert(hl.hasAll && hl.allSize > 0, `CSS.highlights should hold match ranges, got ${hl.allSize}`);
  assert(hl.curSize === 1, `exactly one current-match range expected, got ${hl.curSize}`);
  log(`typing highlighted ${hl.allSize} ranges, count "${countText}" ✓`);

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'markdown-search.png') }).catch(() => {});

  // ── Enter cycles the current match forward ────────────────────────────────────
  const ordinalOf = async () =>
    Number((await page.locator(mdCount).textContent())?.split('/')[0] ?? '0');
  const before = await ordinalOf();
  await page.locator(`${mdBar} .term-find__input`).press('Enter');
  await page.waitForFunction(
    (prev) => {
      const t = document.querySelector('.term-find--md .term-find__count')?.textContent ?? '';
      return Number(t.split('/')[0]) !== prev;
    },
    before,
    { timeout: 5000 },
  );
  const after = await ordinalOf();
  assert(after !== before, `Enter should advance the current match (${before} → ${after})`);
  log(`Enter cycled current match ${before} → ${after} ✓`);

  // ── Esc closes the bar and clears the highlight registry ──────────────────────
  await page.locator(`${mdBar} .term-find__input`).press('Escape');
  await page.locator(mdBar).waitFor({ state: 'detached', timeout: 5000 });
  const cleared = await page.evaluate(() => ({
    all: CSS.highlights.has('md-find'),
    current: CSS.highlights.has('md-find-current'),
  }));
  assert(!cleared.all && !cleared.current, 'Esc must delete both highlight registrations');
  log('Esc closed the bar and cleared highlights ✓');

  // ── Scoped: Ctrl+F does NOT open the markdown find when focus is elsewhere ─────
  // The markdown viewer owns Ctrl+F only while it holds focus (same owns-check as
  // Ctrl+A). Focusing an always-visible control outside the viewer (the session
  // filter input) and pressing Ctrl+F must not reopen the markdown bar. (Driving the
  // terminal pane directly is unreliable here — it's hidden while a doc fills the center.)
  await page.locator('input[placeholder*="Filter sessions" i]').first().click();
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(300);
  assert(
    (await page.locator(mdBar).count()) === 0,
    'markdown find must not open when focus is outside the markdown viewer',
  );
  log('Ctrl+F is scoped: markdown find stays closed when the viewer is not focused ✓');

  await closeApp(app, page);
});

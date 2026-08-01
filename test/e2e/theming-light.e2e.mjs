/**
 * Light-theme legibility — regression guard for the review-diff surface.
 *
 * Round 1 shipped syntax-highlighted Review diffs whose rows used a near-white token color on a
 * white (--panel) card, so on the light theme the diff was white-on-white. The fix seats the diff
 * body on the dark code surface on every theme. The 2026-07-31 revamp replaced Paper with Aero
 * and made this a two-sided contract (F5/Q2): the review CHROME is a light document page
 * (.docpage) while the code it contains stays ink (.inkbox) — because the token contract
 * withdraws the light syntax palette outright, so anything painting --syn-* must sit on ink.
 *
 * Drives the REAL app: open Review on a .ts change, switch to Aero, and assert BOTH halves —
 * a light page around a dark diff body with contrasting tokens — then screenshot for taste.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

const TS_V1 = ['const greeting = "hello world";', 'function old() {', '  return 1;', '}', ''].join(
  '\n',
);
const TS_V2 = [
  '// a friendly greeting',
  'const greeting = "hello there";',
  'function shiny(count: number): number {',
  '  return count * 2;',
  '}',
  '',
].join('\n');

/** Perceived luminance (0..255) of a computed color — handles both `rgb(r, g, b)` and the
 *  `color(srgb r g b)` form that color-mix() surfaces (0..1 channels) serialize to. */
function lum(c) {
  const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(c ?? '');
  if (rgb) return 0.299 * +rgb[1] + 0.587 * +rgb[2] + 0.114 * +rgb[3];
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c ?? '');
  if (srgb) return (0.299 * +srgb[1] + 0.587 * +srgb[2] + 0.114 * +srgb[3]) * 255;
  return -1;
}

runScenario('theming-light', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-theming-light-'));
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'app.ts'), TS_V1);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  writeFileSync(join(root, 'app.ts'), TS_V2);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.review .rcard[data-path="app.ts"]');
      return !!c && !/Loading diff/i.test(c.textContent ?? '') && !!c.querySelector('.rline');
    },
    null,
    { timeout: 15000 },
  );

  // Switch to Aero (the light theme) via the real command (update({theme}) — applied +
  // persisted); a manual data-theme poke gets overwritten by the app's own theme effect.
  // Anchored title match: a bare 'Aero' also matches 'Aero Dark', which is not the light one.
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill('>Theme: Aero'); // keep the command-mode `>` prefix
  await page
    .locator('.palette__title', { hasText: /Theme: Aero$/ })
    .first()
    .click();
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'aero',
    null,
    { timeout: 5000 },
  );

  const probe = await page.evaluate(() => {
    const card = document.querySelector('.review .rcard[data-path="app.ts"]');
    const hunks = card?.querySelector('.rhunks');
    const tok = card?.querySelector('.rline--hl .rline__text span[class*="hljs-"]');
    const gs = (el) => (el ? getComputedStyle(el) : null);
    // The review document page itself: light under Aero (F5/Q2), which is the half of the
    // contract a dark-diff-only assertion would let regress back to an all-black document area.
    const page_ = document.querySelector('.review.docpage');
    return {
      rootTheme: document.documentElement.getAttribute('data-theme'),
      hunksBg: gs(hunks)?.backgroundColor ?? null,
      tokenColor: tok ? getComputedStyle(tok).color : null,
      pageText: gs(page_)?.color ?? null,
      isDocPage: !!page_,
      isInkBox: !!hunks?.classList.contains('inkbox'),
    };
  });
  log(`aero probe: ${JSON.stringify(probe)}`);

  assert(probe.rootTheme === 'aero', 'theme should be aero');
  assert(probe.isDocPage, 'the Review document must be on the light document page (.docpage)');
  assert(probe.isInkBox, 'the diff body must re-ink itself out of that page (.inkbox)');
  const bgL = lum(probe.hunksBg);
  const tokL = lum(probe.tokenColor);
  assert(bgL >= 0, `diff body must have a resolved background, got ${probe.hunksBg}`);
  // The regression fix seats the diff on the dark code surface: body dark, tokens light.
  assert(bgL < 90, `diff body should be a DARK surface on aero, got luminance ${bgL.toFixed(0)}`);
  // …and the page around it is genuinely light: its own text colour is dark ink on a light theme.
  const pageTextL = lum(probe.pageText);
  assert(
    pageTextL >= 0 && pageTextL < 128,
    `the light page must carry dark text, got luminance ${pageTextL.toFixed(0)}`,
  );
  if (tokL >= 0) {
    assert(
      Math.abs(tokL - bgL) > 60,
      `token text must contrast the diff surface (bg ${bgL.toFixed(0)} vs token ${tokL.toFixed(0)})`,
    );
  }
  log('Aero review-diff is legible (light page, dark diff body, contrasting tokens) ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page
    .locator('.review .rcard[data-path="app.ts"]')
    .screenshot({ path: join(shotDir, 'theming-light-review.png') })
    .catch(() => {});

  await closeApp(app, page);
});

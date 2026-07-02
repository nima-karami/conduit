/**
 * Paper (light) theme legibility — regression guard for the review-diff surface.
 *
 * Round 1 shipped syntax-highlighted Review diffs whose rows used a near-white token color on a
 * white (--panel) card, so on the Paper theme the diff was white-on-white. The fix seats the diff
 * body (.rhunks) on the dark --code-surface on every theme. This drives the REAL app: open Review
 * on a .ts change, switch to Paper, and assert the diff body is a DARK surface with LIGHT token
 * text (legible), then screenshot for the taste check.
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

runScenario('theming-paper', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-theming-paper-'));
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

  // Switch to the Paper (light) theme via the real command (update({theme}) — applied +
  // persisted); a manual data-theme poke gets overwritten by the app's own theme effect.
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill('>Theme: Paper'); // keep the command-mode `>` prefix
  await page.locator('.palette__title', { hasText: 'Paper' }).first().click();
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'paper',
    null,
    { timeout: 5000 },
  );

  const probe = await page.evaluate(() => {
    const card = document.querySelector('.review .rcard[data-path="app.ts"]');
    const hunks = card?.querySelector('.rhunks');
    const tok = card?.querySelector('.rline--hl .rline__text span[class*="hljs-"]');
    const gs = (el) => (el ? getComputedStyle(el) : null);
    return {
      rootTheme: document.documentElement.getAttribute('data-theme'),
      hunksBg: gs(hunks)?.backgroundColor ?? null,
      tokenColor: tok ? getComputedStyle(tok).color : null,
    };
  });
  log(`paper probe: theme=${probe.rootTheme} hunksBg=${probe.hunksBg} token=${probe.tokenColor}`);

  assert(probe.rootTheme === 'paper', 'theme should be paper');
  const bgL = lum(probe.hunksBg);
  const tokL = lum(probe.tokenColor);
  assert(bgL >= 0, `diff body must have a resolved background, got ${probe.hunksBg}`);
  // The regression fix seats the diff on the dark code surface: body dark, tokens light.
  assert(bgL < 90, `diff body should be a DARK surface on paper, got luminance ${bgL.toFixed(0)}`);
  if (tokL >= 0) {
    assert(
      Math.abs(tokL - bgL) > 60,
      `token text must contrast the diff surface (bg ${bgL.toFixed(0)} vs token ${tokL.toFixed(0)})`,
    );
  }
  log('Paper review-diff is legible (dark surface + contrasting tokens) ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page
    .locator('.review .rcard[data-path="app.ts"]')
    .screenshot({ path: join(shotDir, 'theming-paper-review.png') })
    .catch(() => {});

  await closeApp(app, page);
});

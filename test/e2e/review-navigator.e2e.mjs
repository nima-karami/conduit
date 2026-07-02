/**
 * review-navigator — the first-class Review surface (spec 2026-07-02-review-changes-first-class):
 * a diffstat SUMMARY header (`N files changed · +X −Y`) and a file NAVIGATOR (click a changed
 * file → its card scrolls into view + expands). Real-app: crosses the working-tree diff IPC and
 * the windowed scroll-to-file path the mock shell can't exercise.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

runScenario('review-navigator', async ({ page, log }) => {
  const shot = join(tmpdir(), 'conduit-shot-review-navigator.png');
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-nav-'));

  // Baseline commit, then a mix of uncommitted edits/adds/delete for a multi-file diffstat.
  const base = {
    'alpha.ts': `${Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join('\n')}\n`,
    'beta.ts': 'export const beta = 1;\n',
    'gamma.md': '# Gamma\n\nold line\n',
    'delete-me.txt': 'remove this file\n',
  };
  git(root, 'init', '-q');
  for (const [f, c] of Object.entries(base)) writeFileSync(join(root, f), c);
  git(root, 'add', '.');
  git(root, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');
  writeFileSync(
    join(root, 'alpha.ts'),
    `${Array.from({ length: 30 }, (_, i) => `const a${i} = ${i * 2};`).join('\n')}\n`,
  );
  writeFileSync(join(root, 'gamma.md'), '# Gamma\n\nnew line\nanother new line\n');
  writeFileSync(join(root, 'newfile.tsx'), 'export const New = () => null;\n');
  unlinkSync(join(root, 'delete-me.txt'));

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 15000 });

  // (1) Diffstat summary header: "N files changed · +X −Y".
  const summary = (await page.textContent('.review__sub'))?.trim() ?? '';
  log(`diffstat header: "${summary}"`);
  assert(
    /\bfiles?\s+changed/.test(summary),
    `header should read "N files changed"; got "${summary}"`,
  );
  assert(
    /\+\d+/.test(summary) && /\d+/.test(summary),
    `header should carry +ins −del; got "${summary}"`,
  );

  // (2) Navigator: toggle open, one row per changed file.
  await page.click('.review__navtoggle');
  await page.waitForSelector('.review__nav .review__navrow', { state: 'visible', timeout: 8000 });
  const { navRows, cardCount } = await page.evaluate(() => ({
    navRows: document.querySelectorAll('.review__nav .review__navrow').length,
    cardCount: document.querySelectorAll('.review .rcard').length,
  }));
  log(`navigator rows: ${navRows} (cards: ${cardCount})`);
  assert(navRows >= 4, `expected ≥4 navigator rows, got ${navRows}`);
  await page.screenshot({ path: shot });
  log(`screenshot: ${shot}`);

  // (3) Click the last file in the navigator → its card scrolls into the viewport and expands.
  const lastPath = await page.evaluate(() => {
    const rows = document.querySelectorAll('.review__nav .review__navrow');
    return rows[rows.length - 1]?.getAttribute('data-path') ?? '';
  });
  assert(lastPath, 'navigator row should carry a data-path');
  await page.locator('.review__nav .review__navrow').last().click();
  // The target card must be in the scroll viewport (top within the review body) after the jump.
  await page.waitForFunction(
    (p) => {
      const card = document.querySelector(`.review .rcard[data-path="${p}"]`);
      const scroll = document.querySelector('.review__scroll');
      if (!card || !scroll) return false;
      const c = card.getBoundingClientRect();
      const s = scroll.getBoundingClientRect();
      return c.top >= s.top - 4 && c.top < s.bottom;
    },
    lastPath,
    { timeout: 8000 },
  );
  log(`jumped to "${lastPath}" — card scrolled into view ✓`);

  log('PASS ✓ review-navigator: diffstat summary + file navigator jump');
});

/**
 * review-mode-pane — Review as a MODE of the right pane's Changes tab (spec
 * 2026-09-05-review-mode §2.1, §7.2 Gherkin 1-3). Real-app: the pane's auto-open/restore
 * decision reads the persisted `explorerCollapsed`/`rightPaneTab` settings the host owns, and
 * the navigator's row count comes from the host-streamed change list — neither the preview
 * mock can produce.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

/** 4 changes: a modify, a delete, an add, and another modify — same shape review-navigator
 *  uses, so the fixture's file count is a known, stable 4. */
const FILE_COUNT = 4;

function makeRepo(dir) {
  const base = {
    'alpha.ts': `${Array.from({ length: 10 }, (_, i) => `const a${i} = ${i};`).join('\n')}\n`,
    'beta.ts': 'export const beta = 1;\n',
    'gamma.md': '# Gamma\n\nold line\n',
    'delete-me.txt': 'remove this file\n',
  };
  git(dir, 'init', '-q');
  for (const [f, c] of Object.entries(base)) writeFileSync(join(dir, f), c);
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');
  writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 2;\n');
  writeFileSync(join(dir, 'gamma.md'), '# Gamma\n\nnew line\n');
  writeFileSync(join(dir, 'newfile.tsx'), 'export const New = () => null;\n');
  unlinkSync(join(dir, 'delete-me.txt'));
}

const rtabActiveText = (page) =>
  page.evaluate(() => document.querySelector('.rtab--active')?.textContent?.trim() ?? '');

const navRowCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.right .review__navrow').length);

runScenario('review-mode-pane', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-mode-pane-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });

  // App shortcuts are ignored while the terminal has focus (webview/app.tsx: keys are left for
  // the shell) — a fresh session focuses it, so move focus off it before the first shortcut.
  await page.click('.topbar__logo');

  // ── Gherkin 1: entering Review from a collapsed pane opens the navigator ─────────────────
  if (await page.isVisible('.right')) {
    await page.keyboard.press('Control+Shift+E');
    await page.waitForSelector('.right', { state: 'detached', timeout: 8000 });
  }
  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.right', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.right .review__navrow').length > 0,
    null,
    { timeout: 15000 },
  );
  assert(
    (await rtabActiveText(page)).startsWith('Changes'),
    'entering Review must select the Changes tab',
  );
  const rows = await navRowCount(page);
  assert(rows === FILE_COUNT, `expected ${FILE_COUNT} navigator rows, got ${rows}`);
  const placement = await page.evaluate(() => ({
    onTrail: !!document.querySelector('.tabbar__trail .review__source'),
    inHeader: !!document.querySelector('.review__head .review__source'),
  }));
  assert(!placement.onTrail, 'the source trigger must not render on the tab row');
  assert(placement.inHeader, 'the source trigger must render inside the Review header');
  log('Gherkin 1: collapsed → Review opens the pane on Changes, 4 rows, source in the header ✓');

  // ── Gherkin 2: closing Review restores the pane (it auto-opened it) ──────────────────────
  await page.locator('.tab', { hasText: 'Review Changes' }).locator('.tab__close').click();
  await page.waitForSelector('.right', { state: 'detached', timeout: 8000 });
  log('Gherkin 2a: closing Review collapses the auto-opened pane ✓');

  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.right', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.rtab--active')?.textContent?.trim().startsWith('Changes'),
    null,
    { timeout: 8000 },
  );
  log('Gherkin 2b: re-opening Review brings the pane back on Changes ✓');

  // ── Gherkin 3: once the user has touched pane visibility, Review closing leaves it alone ─
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('.right', { state: 'detached', timeout: 8000 });
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('.right', { state: 'visible', timeout: 8000 });
  await page.locator('.tab', { hasText: 'Review Changes' }).locator('.tab__close').click();
  await page.waitForTimeout(500);
  assert(await page.isVisible('.right'), 'the pane must stay visible once the user owns it');
  log('Gherkin 3: a manual toggle while Review was open keeps the pane visible after closing ✓');

  // ── Board view mid-review: the navigator is an editor-mode surface only ──────────────────
  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.right', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.right .review__navrow').length > 0,
    null,
    {
      timeout: 15000,
    },
  );

  await page.click('.viewswitch__btn[title="Feature Board"]');
  await page.waitForFunction(() => !document.querySelector('.right .rnav'), null, {
    timeout: 8000,
  });
  const ordinary = await page.evaluate(() => ({
    changeRows: document.querySelectorAll('.right .change').length,
    empty: !!document.querySelector('.right .emptystate'),
  }));
  assert(
    ordinary.changeRows > 0 || ordinary.empty,
    'Board view must fall back to the ordinary Changes list, not the review navigator',
  );
  log('Board view hides the navigator; the ordinary Changes list (or its empty state) shows ✓');

  await page.click('.viewswitch__btn[title="Editor"]');
  await page.waitForSelector('.right .rnav', { state: 'visible', timeout: 8000 });
  log('back to the editor view: the navigator reappears ✓');

  log('PASS ✓ review-mode-pane: mode transitions, restore-on-close, ownership, Board view');
});

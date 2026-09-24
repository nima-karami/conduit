/**
 * Review-Changes entry point (real-app smoke). Review lives in the Changes tab header now
 * (docs/specs/2026-09-23-mf-changes.md §2.4, D18: the old "visible without opening Changes" rule
 * from spec 2026-06-27-review-changes-entry-point is superseded by L8; with the pane collapsed
 * the path is `Mod+Shift+R`). On a clean tree the header's Review button is visible and opens
 * Review's empty state; with the pane collapsed `Mod+Shift+R` opens it; the tab row holds no
 * Review or History control. Crosses the renderer/host boundary (the Changes model needs the
 * host's repo detection and GitInfo), so this can only be proven in the real app.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openChangesTab, openSession, runScenario } from './harness.mjs';

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'committed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

async function assertReviewEmpty(page, how) {
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  const emptyText = await page.textContent('.review');
  assert(
    /Nothing to review/i.test(emptyText ?? ''),
    `${how} on a clean tree should show Review's empty state; got: ${emptyText?.slice(0, 120)}`,
  );
}

runScenario('review-entry-point', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-entry-'));
  makeRepo(root); // clean tree: a committed file, nothing uncommitted

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await openChangesTab(page);
  await page.waitForSelector('.changes__header .changes__review', {
    state: 'visible',
    timeout: 20000,
  });
  log('Review button visible in the Changes header on a clean tree ✓');

  const tabRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tabbar-wrap')];
    const controls = rows.flatMap((r) =>
      [...r.querySelectorAll('button, [role="button"]')].filter((b) => {
        const name = `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`;
        return (
          /review|history|compare/i.test(name) || /git-indicator|changes__review/.test(b.className)
        );
      }),
    );
    return { rows: rows.length, controls: controls.map((b) => b.outerHTML.slice(0, 120)) };
  });
  assert(tabRow.rows > 0, 'the tab row must be rendered');
  assert(
    tabRow.controls.length === 0,
    `the tab row holds no Review / History / Compare control: ${JSON.stringify(tabRow.controls)}`,
  );
  log('tab row: no Review / History / Compare control ✓');

  const header = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.changes__header button'), (b) =>
      `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`.trim(),
    ),
  );
  assert(header.length > 0, 'the Changes header renders its controls');
  assert(
    !header.some((t) => /compare/i.test(t)),
    `the Changes header has no Compare button: ${JSON.stringify(header)}`,
  );
  log('Changes header: no Compare button ✓');

  await page.click('.changes__header .changes__review');
  await assertReviewEmpty(page, 'the header Review button');
  log('header Review on a clean tree opens the Review tab with the empty state ✓');

  // Close Review, collapse the pane, and reach Review by its shortcut alone. App shortcuts are
  // ignored while the terminal has focus, so move focus off it first.
  await page.locator('.tab--active .tab__close').click();
  await page.waitForSelector('.review', { state: 'detached', timeout: 10000 });
  await page.click('.topbar__logo');
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('.right', { state: 'hidden', timeout: 8000 });
  await page.keyboard.press('Control+Shift+R');
  await assertReviewEmpty(page, 'Mod+Shift+R with the pane collapsed');
  log('pane collapsed: Mod+Shift+R opens Review ✓');

  log('PASS ✓ review-entry-point: Review in the Changes header + Mod+Shift+R, tab row clean');
});

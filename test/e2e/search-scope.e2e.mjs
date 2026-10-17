/**
 * Search scope chip (docs/plans/2026-10-16-multi-repo-tracking.plan.md Task 4.5; spec §7 AC
 * "a repo whose .gitignored dist/ holds a matching string returns no dist/ hit under Tracked
 * repos, and one under Everything").
 *
 * Layout: <ws> is not a repo and holds repoA (`.gitignore` = dist/ + gen/; NEEDLE_42 in
 * src/a.ts, dist/out.js and gen/out.js) and repoB (NEEDLE_42 in src/b.ts).
 *
 * Everything is the old capped walk, which never descends into its fixed ignore set (dist,
 * build, out, node_modules…). So the gitignored hit that appears under Everything is gen/out.js;
 * dist/out.js stays out under both scopes (queued as a decision in the run report).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, removeDir, runScenario } from './harness.mjs';

const NEEDLE = 'NEEDLE_42';
const slash = (p) => p.replace(/\\/g, '/');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

function initRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
}

async function waitOrFail(page, fn, arg, timeout, what, observe) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    const seen = await page.evaluate(observe, arg);
    assert(false, `${what} (observed ${JSON.stringify(seen)})`);
  }
}

/** The result files the pane shows, by root-relative path (each group head's title). */
const shownHits = () =>
  Array.from(document.querySelectorAll('.searchgroup__head'), (el) => el.getAttribute('title'))
    .filter(Boolean)
    .sort();

const chipLabel = () =>
  document.querySelector('.search__scopechip .gh__reffilter-label')?.textContent ?? null;

/** Waits until the pane shows exactly `want` (sorted rels) and is not searching. */
async function expectHits(page, want, what) {
  await waitOrFail(
    page,
    (w) => {
      const busy = document.querySelector('.search [role="status"]');
      const hits = Array.from(document.querySelectorAll('.searchgroup__head'), (el) =>
        el.getAttribute('title'),
      )
        .filter(Boolean)
        .sort();
      return !busy && JSON.stringify(hits) === JSON.stringify(w);
    },
    want,
    20000,
    what,
    shownHits,
  );
}

async function openFilesTab(page) {
  if (!(await page.isVisible('.rightpane'))) {
    await page.keyboard.press('Control+Shift+E');
    await page.waitForSelector('.rightpane', { state: 'visible', timeout: 8000 });
  }
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Files'))
      ?.click();
  });
  await page.waitForSelector('.search__inputbox textarea', { state: 'visible', timeout: 15000 });
}

async function search(page, text) {
  const input = page.locator('.search__inputbox textarea');
  await input.click();
  await input.fill(text);
}

runScenario('search-scope', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-search-scope-')));
  const ws = join(root, 'ws');
  const other = join(root, 'other');
  try {
    initRepo(join(ws, 'repoA'), {
      '.gitignore': 'dist/\ngen/\n',
      'src/a.ts': `export const a = '${NEEDLE}';\n`,
    });
    for (const dir of ['dist', 'gen']) {
      mkdirSync(join(ws, 'repoA', dir));
      writeFileSync(join(ws, 'repoA', dir, 'out.js'), `var x = '${NEEDLE}';\n`);
    }
    initRepo(join(ws, 'repoB'), { 'src/b.ts': `export const b = '${NEEDLE}';\n` });
    mkdirSync(other);
    writeFileSync(join(other, 'readme.txt'), 'nothing here\n');

    const otherId = await openSession(page, { path: slash(other) });
    const sid = await openSession(page, { path: slash(ws) });
    await waitOrFail(
      page,
      (id) => ((window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0) === 2,
      sid,
      30000,
      'the repo scan never registered repoA and repoB',
      (id) => (window.__sessions || []).find((s) => s.id === id)?.repos,
    );
    await openFilesTab(page);

    await search(page, NEEDLE);
    await expectHits(
      page,
      ['repoA/src/a.ts', 'repoB/src/b.ts'],
      "All repos: each repo's listed file, no gitignored hit",
    );
    const label = await page.evaluate(chipLabel);
    assert(
      label === 'All repos',
      `the chip reads "All repos" by default (got ${JSON.stringify(label)})`,
    );
    log('default scope "All repos": repoA/src/a.ts + repoB/src/b.ts, no dist/ or gen/ ✓');

    await page.locator('.search__scopechip').click();
    await page.locator('.ctxmenu [role="menuitemradio"]', { hasText: 'Everything' }).click();
    await expectHits(
      page,
      ['repoA/gen/out.js', 'repoA/src/a.ts', 'repoB/src/b.ts'],
      'Everything: the gitignored gen/out.js hit appears',
    );
    const everything = await page.evaluate(chipLabel);
    assert(
      everything === 'Everything (may be slow)',
      `the chip reads Everything (got ${JSON.stringify(everything)})`,
    );
    log('Everything: gitignored repoA/gen/out.js appears ✓');

    await page.click(`.session[data-sessionid="${otherId}"] .session__name`);
    await page.waitForSelector(`.session--active[data-sessionid="${otherId}"]`, { timeout: 10000 });
    await page.click(`.session[data-sessionid="${sid}"] .session__name`);
    await page.waitForSelector(`.session--active[data-sessionid="${sid}"]`, { timeout: 10000 });
    await openFilesTab(page);
    if (!(await page.isVisible('.search__scopechip'))) await search(page, NEEDLE);
    await waitOrFail(
      page,
      () =>
        document.querySelector('.search__scopechip .gh__reffilter-label')?.textContent ===
        'Everything (may be slow)',
      null,
      10000,
      'switching session and back keeps the chip on Everything',
      chipLabel,
    );
    log('session switch and back: chip still on Everything ✓');

    // Keyboard: ArrowDown opens, Escape closes; Enter opens, arrows move, Enter picks.
    const activeRepoRoot = await page.evaluate(
      (id) => (window.__sessions || []).find((s) => s.id === id)?.activeRepoRoot,
      sid,
    );
    assert(activeRepoRoot, 'the session has an active repo');
    const activeName = slash(activeRepoRoot).split('/').pop();
    await page.locator('.search__scopechip').focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
    const focused = await page.evaluate(() =>
      document.activeElement?.classList.contains('search__scopechip'),
    );
    assert(focused, 'Escape returns focus to the chip');
    await page.keyboard.press('Enter');
    await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
    await waitOrFail(
      page,
      (name) =>
        document.querySelector('.search__scopechip .gh__reffilter-label')?.textContent === name,
      activeName,
      5000,
      `Enter, ArrowDown, Enter picks "This repo" (${activeName})`,
      chipLabel,
    );
    const repoHit = activeName === 'repoA' ? 'src/a.ts' : 'src/b.ts';
    await expectHits(page, [repoHit], `This repo (${activeName}): only its own file`);
    log(`keyboard: Enter → ↓ → Enter picks "${activeName}"; hits = [${repoHit}] ✓`);

    const ariaOk = await page.evaluate(() => {
      const chip = document.querySelector('.search__scopechip');
      return chip?.getAttribute('aria-haspopup') === 'menu';
    });
    assert(ariaOk, 'the chip is a menu button (aria-haspopup="menu")');
  } finally {
    await closeApp(app, page);
    await removeDir(root);
  }
});

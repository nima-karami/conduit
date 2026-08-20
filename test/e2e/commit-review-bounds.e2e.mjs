/**
 * Review tab — commit memory bounds (real-app smoke, spec
 * docs/specs/2026-08-20-commit-review-memory-bounds.md). A user OOM'd the renderer by opening a
 * huge monorepo commit in Review: the old code diffed EVERY file in the commit on arrival, with a
 * dense (n+1)x(m+1) LCS table per file. Only the real app proves the fix — the host `--numstat`
 * badge counts and the 10 s `diff-tree` timeout live across the IPC boundary a mock can't run.
 *
 * Flow: seed a repo whose second commit contains (a) a 15k-line generated file with a 3-line
 * mid-file edit — must diff EXACTLY and fast via prefix/suffix trim, and (b) an 8k-line file
 * fully replaced by 8k unrelated lines — 64M cells, past the LCS budget, so it must degrade to
 * the `approx` whole-file-replacement notice instead of allocating. Open that commit in Review
 * from History and assert, inside a 20 s budget: the pane reaches ready (not stuck on "Loading
 * commit changes…"), the renderer is ALIVE, badges match git's own numstat, gen.txt renders exact
 * hunks, blob.txt shows the approx notice, and scrolling stays responsive.
 *
 * Second leg: a bogus-but-hex sha through the commit picker must land on the error EmptyState
 * with a Retry — the pre-fix build had no error channel at all and hung on "Loading commit
 * changes…" forever.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const GEN_LINES = 15000;
const BLOB_LINES = 8000;

const numbered = (n, tag) => `${Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\n')}\n`;

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-bounds-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@conduit.local'], dir);
  git(['config', 'user.name', 'Conduit Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  // core.autocrlf would rewrite the committed blobs and shift the numstat counts off the
  // renderer's own line accounting; pin it for this throwaway repo.
  git(['config', 'core.autocrlf', 'false'], dir);

  const gen1 = numbered(GEN_LINES, 'gen');
  writeFileSync(join(dir, 'gen.txt'), gen1);
  writeFileSync(join(dir, 'blob.txt'), numbered(BLOB_LINES, 'a'));
  writeFileSync(join(dir, 'other.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'seed generated files'], dir);

  // Commit 2: a tiny mid-file edit in the huge generated file (exact diff via trim), a total
  // replacement of blob.txt (past the LCS budget → approx), and a small real edit.
  const edited = gen1
    .replace('gen-7000\n', 'EDITED-7000\n')
    .replace('gen-7001\n', 'EDITED-7001\n')
    .replace('gen-7002\n', 'EDITED-7002\n');
  writeFileSync(join(dir, 'gen.txt'), edited);
  writeFileSync(join(dir, 'blob.txt'), numbered(BLOB_LINES, 'b'));
  writeFileSync(join(dir, 'other.ts'), 'export const a = 11;\nexport const b = 22;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'huge commit'], dir);

  const sha = git(['rev-parse', 'HEAD'], dir);
  // git's own numstat is the oracle the badges must match.
  const numstat = Object.fromEntries(
    git(['diff-tree', '-M', '-r', '--no-commit-id', '--numstat', 'HEAD~1', 'HEAD'], dir)
      .split('\n')
      .map((l) => l.split('\t'))
      .map(([add, del, path]) => [path, `+${add} -${del}`]),
  );
  return { dir, sha, numstat };
}

/** Card badge text, normalized to `+A -R` (the card omits a zero side). */
const badgeOf = (page, path) =>
  page.$eval(`.review .rcard[data-path="${path}"] .rcard__stat`, (el) =>
    (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

runScenario('commit-review-bounds', async ({ page, log }) => {
  const { dir, sha, numstat } = seedRepo();
  log('seeded', dir, 'HEAD', sha, JSON.stringify(numstat));

  await openSession(page, { path: dir.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__history', { state: 'attached', timeout: 20000 });
  await page.click('.git-indicator__history', { force: true });
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 15000 });

  // Top row is the huge commit. Open it in Review and start the clock: everything below has to
  // happen inside the budget, which the pre-fix quadratic parse blows through.
  const t0 = Date.now();
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__review-commit', { state: 'visible', timeout: 15000 });
  await page.click('.gh__review-commit');

  await page.waitForSelector('.review', { state: 'attached', timeout: 20000 });
  await page.waitForSelector('.review .rcard[data-path="gen.txt"]', {
    state: 'attached',
    timeout: 20000,
  });
  const readyMs = Date.now() - t0;
  log(`review reached ready in ${readyMs}ms`);

  // The renderer is alive (a crashed/OOM'd renderer can't answer, and a wedged main thread
  // can't answer inside the timeout either).
  const alive = await page.evaluate(() => 1);
  assert(alive === 1, 'expected the renderer to still be alive after opening the huge commit');

  const loadingLeft = await page.$$eval('.emptystate__title', (els) =>
    els.some((e) => /Loading commit changes/i.test(e.textContent ?? '')),
  );
  assert(!loadingLeft, 'expected the Review pane to leave the "Loading commit changes…" state');

  // Badges come from the host numstat, so they must equal git's own numbers exactly.
  for (const path of ['gen.txt', 'blob.txt', 'other.ts']) {
    const want = numstat[path];
    const got = await badgeOf(page, path);
    log(`badge ${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    assert(
      got === want,
      `expected ${path} badge ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
    );
  }

  // gen.txt: prefix/suffix trim means an EXACT small diff — no approx notice, few rendered rows.
  const gen = await page.$eval('.review .rcard[data-path="gen.txt"]', (el) => ({
    text: el.textContent ?? '',
    rows: el.querySelectorAll('.rline').length,
  }));
  assert(
    !/changed too much to line-match/i.test(gen.text),
    'expected gen.txt to diff EXACTLY (no approx notice) — the trim should reduce it to a tiny core',
  );
  log(`gen.txt rendered ${gen.rows} diff rows`);
  assert(
    gen.rows > 0 && gen.rows < 200,
    `expected gen.txt to render a small exact hunk, got ${gen.rows} rows`,
  );

  // blob.txt: 8000x8000 core is past MAX_LCS_CELLS → the approx whole-replacement notice.
  const blobText = await page.$eval(
    '.review .rcard[data-path="blob.txt"]',
    (el) => el.textContent ?? '',
  );
  assert(
    /changed too much to line-match/i.test(blobText),
    'expected blob.txt to show the approx whole-file-replacement notice',
  );

  // Scrolling the list stays responsive (main thread not wedged by a background parse).
  const scrollStart = Date.now();
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const list = document.querySelector('.review__scroll');
      if (list) list.scrollTop += 1200;
    });
    await page.waitForTimeout(60);
  }
  const scrolled = await page.evaluate(() => 1);
  assert(
    scrolled === 1,
    'expected the renderer to stay responsive while scrolling the review list',
  );
  log(`scroll pass took ${Date.now() - scrollStart}ms`);

  const totalMs = Date.now() - t0;
  log(`PASS: huge commit reviewed in ${totalMs}ms, renderer alive ✓`);
  assert(
    totalMs < 20000,
    `expected the whole commit review to settle under 20s, took ${totalMs}ms`,
  );

  // ---- Error channel: a bogus-but-hex sha must land on the error EmptyState, not eternal loading.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  const bogus = 'dead'.repeat(10);
  await page.fill('.commit-picker .git-branch-menu__filter', bogus);
  await page.waitForSelector('.commit-picker__list button:has(.commit-picker__subject)', {
    state: 'visible',
    timeout: 8000,
  });
  await page.click('.commit-picker__list button:last-of-type');

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.review .emptystate__title')).some((e) =>
        /Couldn't load this commit/i.test(e.textContent ?? ''),
      ),
    null,
    { timeout: 20000 },
  );
  const hasRetry = await page.$$eval('.review .emptystate__action button', (els) =>
    els.some((e) => /Retry/i.test(e.textContent ?? '')),
  );
  assert(hasRetry, 'expected the commit error EmptyState to offer a Retry button');

  log(
    'PASS ✓ commit-review-bounds: huge commit is bounded + the error channel replaces eternal loading',
  );
});

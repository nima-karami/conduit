/**
 * Review Changes — collapsible cards + large/added-file portioning (real-app smoke).
 * Spec 2026-06-29-review-card-collapse.
 *
 * Both behaviours are DOM/measurement-driven and can't be proven in the preview mock: the
 * change list + per-card diffs stream from the host, and collapse re-flows the windowed list via
 * a real ResizeObserver. So this drives the built app.
 *
 * Asserts:
 *   (a) a newly-added ~1000-line file card renders a BOUNDED portion (≈300 diff rows, far fewer
 *       than 1000) plus a "Show all" control — not the whole file;
 *   (b) clicking the card header collapses the body (the `.rhunks` body disappears, the header
 *       stays) and clicking again expands it;
 *   (c) "Show all" reveals every row and swaps to "Show less"; other cards still render.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const BIG_LINES = 1000;
const PORTION = 300; // MAX_CARD_ROWS in review-view.tsx

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  // A new, untracked file with BIG_LINES lines → one all-add hunk (the exact complaint).
  // Named to sort FIRST so it mounts at the top of the windowed list.
  const big = Array.from({ length: BIG_LINES }, (_, i) => `big line ${i + 1}`).join('\n');
  writeFileSync(join(dir, 'a-big.txt'), `${big}\n`);
  // A small added file to give the collapse screenshot a mix (one collapsed + one expanded).
  writeFileSync(join(dir, 'b-small.txt'), 'small one\nsmall two\nsmall three\n');
}

const bigSel = '.review .rcard[data-path="a-big.txt"]';

runScenario('review-card-collapse', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-collapse-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });

  // Wait for the big card's diff to render (its hunk rows appear once the host streams the diff).
  await page.waitForSelector(`${bigSel} .rhunks .rline`, { state: 'attached', timeout: 20000 });

  // (a) BOUNDED portion: the all-add 1000-line file renders ≈PORTION rows, not all 1000.
  const bigRows = await page.$$eval(`${bigSel} .rline`, (els) => els.length);
  log(`a-big.txt rendered diff rows: ${bigRows} (file has ${BIG_LINES} lines)`);
  assert(
    bigRows <= PORTION + 5,
    `expected the big card to be portioned to ≈${PORTION} rows; got ${bigRows}`,
  );
  assert(
    bigRows < BIG_LINES / 2,
    `expected far fewer rows than the ${BIG_LINES}-line file; got ${bigRows}`,
  );

  // …and a "Show all" control to reveal the rest.
  const showAll = await page.textContent(`${bigSel} .rcard__showrest`);
  log(`big card cap control: ${JSON.stringify(showAll)}`);
  assert(
    /show all/i.test(showAll ?? ''),
    `expected a "Show all" control; got ${JSON.stringify(showAll)}`,
  );

  // Screenshot (i): the large-added-file card with the bounded portion + the "Show all" control.
  await page.$eval(`${bigSel} .rcard__showrest`, (el) => el.scrollIntoView({ block: 'center' }));
  const shotPortion = join(tmpdir(), 'conduit-shot-card-collapse-portion.png');
  await page.screenshot({ path: shotPortion });
  log(`SCREENSHOT portion: ${shotPortion}`);

  // (c) "Show all" → every row renders + a "Show less" control; back to the portion on "Show less".
  await page.$eval(`${bigSel} .rcard__showrest`, (el) => el.click());
  await page.waitForFunction(
    (sel) => document.querySelectorAll(`${sel} .rline`).length > 900,
    bigSel,
    { timeout: 10000 },
  );
  const fullRows = await page.$$eval(`${bigSel} .rline`, (els) => els.length);
  const showLess = await page.textContent(`${bigSel} .rcard__showrest`);
  log(`after Show all: rows=${fullRows} control=${JSON.stringify(showLess)}`);
  assert(fullRows >= BIG_LINES, `expected all ${BIG_LINES} rows after Show all; got ${fullRows}`);
  assert(
    /show less/i.test(showLess ?? ''),
    `expected "Show less"; got ${JSON.stringify(showLess)}`,
  );
  // Back to the portion.
  await page.$eval(`${bigSel} .rcard__showrest`, (el) => el.click());
  await page.waitForFunction(
    (a) => document.querySelectorAll(`${a.sel} .rline`).length <= a.cap + 5,
    { sel: bigSel, cap: PORTION },
    { timeout: 10000 },
  );
  log('Show less returned the big card to its portion ✓');

  // (b) COLLAPSE: clicking the header toggle hides the body; the header stays.
  await page.$eval(`${bigSel} .rcard__toggle`, (el) => el.click());
  await page.waitForFunction((sel) => !document.querySelector(`${sel} .rhunks`), bigSel, {
    timeout: 8000,
  });
  const headStillThere = await page.evaluate(
    (sel) => !!document.querySelector(`${sel} .rcard__head`),
    bigSel,
  );
  const expandedAttr = await page.getAttribute(`${bigSel} .rcard__toggle`, 'aria-expanded');
  log(`collapsed: body gone, header present=${headStillThere}, aria-expanded=${expandedAttr}`);
  assert(headStillThere, 'collapsed card must keep its header');
  assert(
    expandedAttr === 'false',
    `collapsed toggle must report aria-expanded=false; got ${expandedAttr}`,
  );

  // Other cards still render (no crash, windowing intact).
  const otherCards = await page.$$eval('.review .rcard', (els) => els.length);
  assert(
    otherCards >= 2,
    `expected the small card to still render alongside; got ${otherCards} cards`,
  );

  // Screenshot (ii): a mix — a-big.txt COLLAPSED above b-small.txt EXPANDED.
  await page.$eval('.review__scroll', (el) => {
    el.scrollTop = 0;
  });
  const shotMix = join(tmpdir(), 'conduit-shot-card-collapse-mix.png');
  await page.screenshot({ path: shotMix });
  log(`SCREENSHOT mix: ${shotMix}`);

  // Expand again → body returns.
  await page.$eval(`${bigSel} .rcard__toggle`, (el) => el.click());
  await page.waitForSelector(`${bigSel} .rhunks`, { state: 'attached', timeout: 8000 });
  const reExpanded = await page.getAttribute(`${bigSel} .rcard__toggle`, 'aria-expanded');
  log(`re-expanded: aria-expanded=${reExpanded}`);
  assert(
    reExpanded === 'true',
    `re-expanded toggle must report aria-expanded=true; got ${reExpanded}`,
  );

  log('PASS ✓ review-card-collapse: bounded portion + two-way cap + header collapse/expand');
});

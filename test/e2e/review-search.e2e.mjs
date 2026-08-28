/**
 * review-search — search in diff + the navigator's file filter (spec
 * 2026-08-27-review-supercharge §2 Lane C, §7 Lane C).
 *
 * Real-app: the fixture is a 200-file COMMIT source, whose diffs only exist because the host runs
 * `git show` per file, and the partial-coverage half needs the working source's per-card streaming
 * loader — neither of which the preview mock can produce. The load-bearing claim is that search
 * reads LOADED `FileReview` data, not the DOM: every assertion below picks a needle the renderer
 * cannot have painted yet (a collapsed card, a row past the 40-row cap, an unmounted card).
 *
 * Windows only. Run it ALONE on a quiet machine.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

/** Plain files, plus folded.ts and capped.ts, is the 200-file commit §7 Lane C asks for. */
const PLAIN = 198;
const TOTAL = PLAIN + 2;

const plainName = (i) => `f${String(i).padStart(3, '0')}.ts`;
/** The one plain file carrying a needle that occurs exactly once in the whole changeset. */
const UNIQUE_FILE = plainName(42);

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'e2e@conduit.test');
  git(dir, 'config', 'user.name', 'e2e');
  git(dir, 'config', 'commit.gpgsign', 'false');

  for (let i = 0; i < PLAIN; i++) {
    writeFileSync(join(dir, plainName(i)), `${lines(6, (n) => `const a${n} = ${n};`)}\n`);
  }
  // folded.ts: the needle sits on an UNCHANGED line far from the only edit, so it ends up inside
  // a collapsed fold — the case search must NOT find.
  writeFileSync(
    join(dir, 'folded.ts'),
    `${lines(80, (n) => (n === 4 ? 'const ctx = "ZQFOLDONLY";' : `const c${n} = ${n};`))}\n`,
  );
  writeFileSync(join(dir, 'capped.ts'), `${lines(10, (n) => `const p${n} = ${n};`)}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');

  // The reviewed commit touches every file.
  for (let i = 0; i < PLAIN; i++) {
    const name = plainName(i);
    const extra = name === UNIQUE_FILE ? '\nconst uniq = "ZQUNIQUE";' : '';
    writeFileSync(
      join(dir, name),
      `${lines(6, (n) => `const a${n} = ${n};`)}\nconst zq = "ZQNEEDLE";${extra}\n`,
    );
  }
  writeFileSync(
    join(dir, 'folded.ts'),
    `${lines(80, (n) => (n === 4 ? 'const ctx = "ZQFOLDONLY";' : `const c${n} = ${n};`))}\nconst tail = "ZQFOLDCHANGED";\n`,
  );
  // A different identifier prefix so the line matcher reads this as one clean replacement:
  // 10 removed + 120 added = 130 rows, far past the 40-row cap, with the needle near the end.
  writeFileSync(
    join(dir, 'capped.ts'),
    `${lines(120, (n) => (n === 100 ? 'const q100 = "ZQCAPPED";' : `const q${n} = ${n};`))}\n`,
  );
  git(dir, 'commit', '-qam', 'wide');

  // Uncommitted on top: what the WORKING source streams per card.
  for (let i = 0; i < PLAIN; i++) {
    const name = plainName(i);
    const extra = name === UNIQUE_FILE ? '\nconst uniq = "ZQUNIQUE";' : '';
    writeFileSync(
      join(dir, name),
      `${lines(6, (n) => `const a${n} = ${n};`)}\nconst zq = "ZQNEEDLE";${extra}\nconst w = "ZQWORK";\n`,
    );
  }
}

const BAR = '.review .term-find--review';
const STATUS = `${BAR} .review__searchstatus`;

const status = (page) => page.textContent(STATUS).then((t) => (t ?? '').trim());

const waitForStatus = (page, re, timeout = 20000) =>
  page.waitForFunction(
    ([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.textContent?.trim() ?? ''),
    [STATUS, re.source],
    { timeout },
  );

/** Replace the query outright (a `fill` is one input event, so the count settles once). */
async function search(page, text) {
  await page.fill(`${BAR} .term-find__input`, text);
}

/** Is a row carrying `needle` rendered inside `path`'s card right now? */
const rowShown = (page, path, needle) =>
  page.evaluate(
    ([p, n]) =>
      Array.from(
        document.querySelectorAll(`.review .rcard[data-path="${p}"] .rline`),
        (r) => r.textContent ?? '',
      ).some((t) => t.includes(n)),
    [path, needle],
  );

runScenario('review-search', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-search-'));
  makeRepo(root);
  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });

  await openSession(page, { path: root.replace(/\\/g, '/') });

  // ── Open Review on the top commit (the 200-file source) ──────────────────────────────────
  await page.waitForSelector('.git-indicator__history', { state: 'attached', timeout: 25000 });
  await page.click('.git-indicator__history', { force: true });
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 20000 });
  await page.click('.gh__row', { force: true });
  await page.waitForSelector('.gh__review-commit', { state: 'visible', timeout: 15000 });
  await page.click('.gh__review-commit');
  await page.waitForSelector('.review .rcard', { state: 'attached', timeout: 20000 });
  const shown = await page
    .waitForFunction(
      (want) => {
        const m = (document.querySelector('.review__sub')?.textContent ?? '').match(
          /(\d+)\s+files?\b/,
        );
        return m && Number(m[1]) === want ? Number(m[1]) : false;
      },
      TOTAL,
      { timeout: 40000 },
    )
    .then((h) => h.jsonValue());
  log(`commit source loaded: ${shown} files`);

  // ── (1) `/` opens the bar; the count reports every match across the whole changeset ───────
  await page.evaluate(() => document.querySelector('.review__scroll')?.focus());
  await page.keyboard.press('/');
  await page.waitForSelector(BAR, { state: 'visible', timeout: 8000 });
  assert(
    await page.evaluate((s) => document.querySelector(s)?.getAttribute('role') === 'search', BAR),
    'the find bar must expose role="search" (§9)',
  );

  const t0 = Date.now();
  await search(page, 'ZQNEEDLE');
  await waitForStatus(page, /^1 \/ 198$/);
  const elapsed = Date.now() - t0;
  log(`"ZQNEEDLE" → ${await status(page)} in ${elapsed} ms`);
  // §7 Lane C's budget is 100 ms for the reactive update; this first query also pays for the
  // one-off corpus build over 200 files, and the bound is loose enough to survive a busy box
  // while still failing a corpus rebuilt per keystroke.
  assert(elapsed < 3000, `the count must land promptly (§7 Lane C: 100 ms); took ${elapsed} ms`);

  // Only a handful of the 198 cards are mounted, so this count cannot have come from the DOM.
  const mountedCards = await page.evaluate(
    () => document.querySelectorAll('.review .rcard').length,
  );
  assert(
    mountedCards < PLAIN / 2,
    `the window must mount far fewer than ${PLAIN} cards for this to prove anything; got ${mountedCards}`,
  );
  log(`counted 198 matches with only ${mountedCards} cards mounted ✓`);

  // ── (2) Aa: case-insensitive by default, exact when pressed ───────────────────────────────
  await search(page, 'zqneedle');
  await waitForStatus(page, /^1 \/ 198$/);
  await page.click(`${BAR} .review__casebtn`);
  await waitForStatus(page, /^No matches$/);
  assert(
    await page.isVisible(BAR),
    'zero matches must leave the bar open with "No matches" inline (§2 Lane C)',
  );
  await page.click(`${BAR} .review__casebtn`);
  await waitForStatus(page, /^1 \/ 198$/);
  log('Aa toggles case sensitivity; zero matches reads "No matches" and keeps the bar ✓');

  // ── (3) A COLLAPSED card is searched, and Enter expands it to reveal the match ────────────
  await page.click('.review__collapseall');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.review .rcard__toggle[aria-expanded="false"]').length > 0 &&
      document.querySelectorAll('.review .rcard__toggle[aria-expanded="true"]').length === 0,
    null,
    { timeout: 10000 },
  );
  await search(page, 'ZQUNIQUE');
  await waitForStatus(page, /^1 \/ 1$/);
  log(`"ZQUNIQUE" found in a fully collapsed list: ${await status(page)} ✓`);
  await page.click(`${BAR} .term-find__input`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (p) =>
      document
        .querySelector(`.review .rcard[data-path="${p}"] .rcard__toggle`)
        ?.getAttribute('aria-expanded') === 'true',
    UNIQUE_FILE,
    { timeout: 15000 },
  );
  assert(
    await rowShown(page, UNIQUE_FILE, 'ZQUNIQUE'),
    `Enter must reveal the matching row inside ${UNIQUE_FILE}`,
  );
  log(`Enter expanded ${UNIQUE_FILE} and revealed the match ✓`);

  // ── (4) A row past the 40-row cap is searched, and Enter lifts the cap ────────────────────
  await page.click('.review__expandall');
  await search(page, 'ZQCAPPED');
  await waitForStatus(page, /^1 \/ 1$/);
  assert(
    !(await rowShown(page, 'capped.ts', 'ZQCAPPED')),
    'the capped row must be found while it is NOT rendered — that is the data-not-DOM claim',
  );
  await page.click(`${BAR} .term-find__input`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      Array.from(
        document.querySelectorAll('.review .rcard[data-path="capped.ts"] .rline'),
        (r) => r.textContent ?? '',
      ).some((t) => t.includes('ZQCAPPED')),
    null,
    { timeout: 15000 },
  );
  log('a match past the 40-row cap was counted, then revealed by lifting the cap ✓');

  // capped.ts is on screen with its cap lifted, so a needle every one of its rows carries fills
  // the viewport with highlights — the shot that shows the painting actually works.
  await search(page, 'const q');
  await waitForStatus(page, /^1 \/ 120$/);
  await page.click(`${BAR} .term-find__input`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const shot = join(shotDir, 'lane-c-search.png');
  await page.screenshot({ path: shot });
  log(`screenshot: ${shot}`);

  // ── (5) Folded unchanged context is NOT part of the corpus ────────────────────────────────
  await search(page, 'ZQFOLDCHANGED');
  await waitForStatus(page, /^1 \/ 1$/);
  await search(page, 'ZQFOLDONLY');
  await waitForStatus(page, /^No matches$/);
  log('folded.ts matches on its changed line but not on the line inside the fold ✓');

  // ── (6) Esc closes the bar and leaves Review open ─────────────────────────────────────────
  await page.keyboard.press('Escape');
  await page.waitForSelector(BAR, { state: 'detached', timeout: 8000 });
  assert(await page.isVisible('.review'), 'the first Esc closes search only, never Review');
  log('Esc unwound search first, Review stayed open ✓');

  // ── (7) The navigator's file filter narrows navigator AND cards ───────────────────────────
  // Both columns are windowed, so their ROW COUNTS prove nothing on their own; the filter's own
  // "n of m" readout is over the whole list, which is what "narrows" has to mean here.
  await page.fill('.review__filterinput', 'f042');
  await page.waitForSelector('.review__filtercount', { state: 'visible', timeout: 10000 });
  const kept = await page.textContent('.review__filtercount').then((t) => (t ?? '').trim());
  log(`filter "f042": ${kept}`);
  assert(
    new RegExp(`^[1-9] of ${TOTAL}$`).test(kept),
    `the filter must narrow ${TOTAL} files to a handful; readout was "${kept}"`,
  );
  const navAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.review__navrow'), (r) => r.getAttribute('data-path')),
  );
  const cardsAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.review .rcard'), (c) => c.getAttribute('data-path')),
  );
  assert(navAfter.includes(UNIQUE_FILE), `the filter must keep ${UNIQUE_FILE}`);
  assert(
    cardsAfter.length > 0 && cardsAfter.every((p) => navAfter.includes(p)),
    `the filter must narrow the cards too; got ${JSON.stringify(cardsAfter)}`,
  );
  await page.click('.review__filterinput');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.review__filtercount', { state: 'detached', timeout: 8000 });
  assert(await page.isVisible('.review'), 'Esc in the filter clears it and does not close Review');
  log('Esc cleared the file filter without unwinding Review ✓');

  // ── (8) Working source: partial coverage, then "Search all files" ─────────────────────────
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  await page.click('.commit-picker__list .commit-picker__row:has(.commit-picker__working)');
  await page.waitForFunction(
    (want) => {
      const m = (document.querySelector('.review__sub')?.textContent ?? '').match(
        /(\d+)\s+files?\b/,
      );
      return m && Number(m[1]) === want;
    },
    PLAIN,
    { timeout: 30000 },
  );
  await page.evaluate(() => document.querySelector('.review__scroll')?.focus());
  await page.keyboard.press('/');
  await page.waitForSelector(BAR, { state: 'visible', timeout: 8000 });
  await search(page, 'ZQWORK');
  await waitForStatus(page, /in \d+ of 198 files/);
  const partial = await status(page);
  const covered = Number(/in (\d+) of 198 files/.exec(partial)?.[1] ?? '0');
  log(`working source, streaming: "${partial}"`);
  assert(
    covered > 0 && covered < PLAIN,
    `the working source must start partially loaded; status was "${partial}"`,
  );

  await page.click(`${BAR} .review__searchall`);
  await waitForStatus(page, /^1 \/ 198$/, 90000);
  const complete = await status(page);
  log(`after "Search all files": "${complete}"`);
  assert(
    !/ of 198 files/.test(complete),
    `"Search all files" must clear the partial notice; status was "${complete}"`,
  );

  log(
    'PASS ✓ review-search: data-not-DOM corpus, reveal past collapse and cap, folds excluded, file filter, streamed coverage',
  );
});

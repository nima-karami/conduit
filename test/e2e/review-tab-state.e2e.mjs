/**
 * review-tab-state — the Review Changes tab keeps ALL of its state across a tab round-trip.
 *
 * The user's complaint: leaving Review for another tab and coming back forgets the scroll
 * position (and everything folded / unfolded / collapsed with it). Every piece of that state
 * lives in per-instance React state or refs inside `ReviewView`, which `center-pane.tsx`
 * unmounts when another doc becomes active — so this can only be proven against the real app
 * (the preview mock has no host-streamed diffs and no real measurement/windowing).
 *
 * Asserts, after Review → file tab → Review:
 *   1. the scroller's exact `scrollTop` is back (the headline complaint);
 *   2. a collapsed card is still collapsed, an expanded one still expanded;
 *   3. an expanded fold still shows the lines it revealed;
 *   4. the navigator's file filter and the find bar's query survive.
 *
 * The card assertions are read at the TOP of the list, not at the restored offset: the list is
 * windowed, so the cards mutated in step 1 are not mounted at a scrolled position.
 *
 * GOTCHA (CLAUDE.md): the runner drives ./out — run `npm run build` first.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const FILES = 14;
const BODY_LINES = 120;
const name = (n) => `f${String(n).padStart(2, '0')}.txt`;
/** Its first fold gets expanded. Top of the list ⇒ always in the window at scrollTop 0. */
const FOLD = name(1);
/** Collapsed. Also top-of-list for the same reason. */
const COLLAPSE = name(2);
/** Matches every fixture file, so setting it does not shorten the list (which would reset scroll). */
const FILTER = 'f';
const QUERY = 'edited';

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  const base = (n) => Array.from({ length: BODY_LINES }, (_, i) => `${n} line ${i + 1}`);
  for (let n = 1; n <= FILES; n++) writeFileSync(join(dir, name(n)), `${base(n).join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // Two edits far apart in every file → two hunks with a ~110-line UNCHANGED run between them,
  // which Review renders as a fold. That gives the test both a fold to expand and enough card
  // height for the list to scroll.
  //
  // Every third file is rewritten WHOLESALE. Its card is capped at 40 rendered rows while
  // `estimateCardHeight` bills it for all ~240 changed lines, so the estimate table and the
  // measured one disagree wildly — which is exactly the real-repo shape that makes an
  // estimate-resolved scroll anchor land in the wrong place. f01/f02 stay small so both
  // survive in the window at the top of the list.
  for (let n = 1; n <= FILES; n++) {
    const lines = base(n);
    if (n % 3 === 0) {
      writeFileSync(join(dir, name(n)), `${lines.map((l) => `${l} rewritten`).join('\n')}\n`);
      continue;
    }
    lines[3] = `${n} line 4 edited`;
    lines[BODY_LINES - 4] = `${n} line ${BODY_LINES - 3} edited`;
    writeFileSync(join(dir, name(n)), `${lines.join('\n')}\n`);
  }
}

const card = (path) => `.review .rcard[data-path="${path}"]`;

/** The per-card state, read at the top of the list where both target cards are mounted. */
const topState = (page) =>
  page.evaluate(
    (sel) => {
      const read = (p) => {
        const el = document.querySelector(`.review .rcard[data-path="${p}"]`);
        if (!el) return null;
        return {
          expanded: el.querySelector('.rcard__toggle')?.getAttribute('aria-expanded') ?? null,
          rows: el.querySelectorAll('.rline').length,
          hidden: el.querySelector('.rfold__count')?.textContent ?? null,
        };
      };
      return { fold: read(sel.fold), collapse: read(sel.collapse) };
    },
    { fold: FOLD, collapse: COLLAPSE },
  );

const chrome = (page) =>
  page.evaluate(() => ({
    scrollTop: Math.round(document.querySelector('.review__scroll')?.scrollTop ?? -1),
    scrollHeight: Math.round(document.querySelector('.review__scroll')?.scrollHeight ?? -1),
    // The file at the top of the viewport — what the user actually perceives as "where I was".
    // A px offset alone can match while the list resolves to a different card.
    topCard: (() => {
      const el = document.querySelector('.review__scroll');
      if (!el) return null;
      const y = el.getBoundingClientRect().top;
      const c = Array.from(document.querySelectorAll('.review .rcard')).find(
        (n) => n.getBoundingClientRect().bottom > y,
      );
      return c ? c.getAttribute('data-path') : null;
    })(),
    filter: document.querySelector('.review__filterinput')?.value ?? null,
    query: document.querySelector('.term-find--review .term-find__input')?.value ?? null,
    findOpen: !!document.querySelector('.term-find--review'),
  }));

const scrollTo = async (page, top) => {
  await page.$eval(
    '.review__scroll',
    (el, t) => {
      el.scrollTop = t;
    },
    top,
  );
  // Past the 120ms anchor-capture debounce, and past the re-window + re-measure it triggers
  // (hidden windows throttle frames, so the ResizeObserver pass lands a beat later).
  await page.waitForTimeout(900);
};

runScenario('review-tab-state', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-state-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 15000 });
  await page.waitForSelector(`${card(FOLD)} .rhunks .rline`, { state: 'attached', timeout: 25000 });
  await page.waitForSelector(`${card(COLLAPSE)} .rhunks .rline`, {
    state: 'attached',
    timeout: 25000,
  });

  // ── 1. Set the state up, in the order the app allows ────────────────────────────────────
  // The file filter resets the scroll on purpose, so it goes FIRST and the scroll last.
  await page.fill('.review__filterinput', FILTER);
  await page.waitForTimeout(200);

  // Find bar: `/` is scoped to focus inside the scroller (Lane B keymap).
  await page.click('.review__scroll');
  await page.keyboard.press('/');
  await page.waitForSelector('.term-find--review .term-find__input', {
    state: 'visible',
    timeout: 8000,
  });
  await page.fill('.term-find--review .term-find__input', QUERY);
  await page.waitForTimeout(200);

  await page.$eval(`${card(COLLAPSE)} .rcard__toggle`, (el) => el.click());
  await page.waitForFunction((sel) => !document.querySelector(`${sel} .rhunks`), card(COLLAPSE), {
    timeout: 8000,
  });

  const foldRowsBefore = await page.$$eval(`${card(FOLD)} .rline`, (els) => els.length);
  // A bounded reveal (+10 lines), not "Show all": expanding the whole 110-line unchanged run
  // makes this card taller than the window and unmounts the collapsed card below it.
  await page.$eval(`${card(FOLD)} .rfold__exp`, (el) => el.click());
  await page.waitForFunction(
    (a) => document.querySelectorAll(`${a.sel} .rline`).length > a.before,
    { sel: card(FOLD), before: foldRowsBefore },
    { timeout: 8000 },
  );
  await page.waitForTimeout(600);

  const cardsBefore = await topState(page);
  log('cards BEFORE', JSON.stringify(cardsBefore));
  assert(cardsBefore.collapse?.expanded === 'false', `${COLLAPSE} did not collapse`);
  assert(
    cardsBefore.fold !== null && cardsBefore.fold.rows > foldRowsBefore,
    `${FOLD}'s fold did not expand (${foldRowsBefore} → ${cardsBefore.fold?.rows})`,
  );

  // ── 2. Scroll a meaningful distance ─────────────────────────────────────────────────────
  const target = await page.$eval('.review__scroll', (el) => Math.round(el.scrollHeight * 0.4));
  await scrollTo(page, target);
  const before = await chrome(page);
  log('chrome BEFORE', JSON.stringify(before));
  assert(before.scrollTop > 200, `expected a meaningful scroll offset, got ${before.scrollTop}`);
  assert(before.filter === FILTER, `filter should be ${FILTER}, got ${before.filter}`);
  assert(before.query === QUERY, `query should be ${QUERY}, got ${before.query}`);

  // ── 3. Leave Review for another tab, then come back ─────────────────────────────────────
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  await page
    .locator('.filerow', { hasText: name(1) })
    .first()
    .dblclick();
  await page.waitForSelector('.viewer__monaco .view-lines', { state: 'attached', timeout: 25000 });
  await page.waitForFunction(() => !document.querySelector('.review'), null, { timeout: 8000 });
  log('Review unmounted behind the file tab ✓');

  await page.locator('.tabbar [role="tab"]', { hasText: 'Review Changes' }).first().click();
  await page.waitForSelector('.review', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('.review .rcard .rhunks .rline', {
    state: 'attached',
    timeout: 25000,
  });
  // Same settle window the "before" reading got, so the two are taken under equal conditions.
  await page.waitForTimeout(900);

  const after = await chrome(page);
  log('chrome AFTER ', JSON.stringify(after));

  // 3a. The headline: the exact scroll position, and the file it lands on.
  assert(
    Math.abs(after.scrollTop - before.scrollTop) <= 2,
    `scroll not restored: was ${before.scrollTop}, got ${after.scrollTop} (drift ${after.scrollTop - before.scrollTop}px)`,
  );
  assert(
    after.topCard === before.topCard,
    `restored to the wrong file: was at ${before.topCard}, landed on ${after.topCard}`,
  );
  // The list must come back the same height too — an estimate-based height table is what makes
  // the anchor resolve somewhere else.
  assert(
    Math.abs(after.scrollHeight - before.scrollHeight) <= 2,
    `list height changed across the round-trip: was ${before.scrollHeight}, got ${after.scrollHeight}`,
  );
  // 3b. Find bar + file filter.
  assert(after.findOpen, 'the find bar should still be open after the round-trip');
  assert(after.query === QUERY, `query lost: was ${QUERY}, got ${JSON.stringify(after.query)}`);
  assert(
    after.filter === FILTER,
    `filter lost: was ${FILTER}, got ${JSON.stringify(after.filter)}`,
  );

  // ── 4. Back to the top: the collapsed card and the expanded fold ────────────────────────
  await scrollTo(page, 0);
  await page.waitForSelector(`${card(FOLD)} .rcard__toggle`, { state: 'attached', timeout: 15000 });
  const cardsAfter = await topState(page);
  log('cards AFTER ', JSON.stringify(cardsAfter));

  assert(
    cardsAfter.collapse?.expanded === 'false',
    `${COLLAPSE} should still be collapsed, got aria-expanded=${JSON.stringify(cardsAfter.collapse?.expanded)}`,
  );
  assert(
    cardsAfter.fold?.rows === cardsBefore.fold.rows,
    `${FOLD}'s expanded fold was forgotten: was ${cardsBefore.fold.rows} rows, got ${JSON.stringify(cardsAfter.fold?.rows)}`,
  );
  assert(
    cardsAfter.fold?.hidden === cardsBefore.fold.hidden,
    `${FOLD}'s fold state changed: was ${JSON.stringify(cardsBefore.fold.hidden)}, got ${JSON.stringify(cardsAfter.fold?.hidden)}`,
  );

  log('PASS ✓ review-tab-state: scroll, collapse, folds, filter and search all survived');
});

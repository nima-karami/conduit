/**
 * Middle-click on the Review and History surfaces opens a background tab (spec
 * 2026-09-22-middle-click-new-tab §9 S5–S8, §7 AC-4). S7 must not move the Review's current hunk,
 * and a background hunk open must still land on the hunk's line when its tab is first activated.
 */

import { execFileSync } from 'node:child_process';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';
import {
  middleClickJitter,
  sameSnapshot,
  snapshotUnchanged,
  tabInfo,
  writeFixtureRepo,
} from './middle-click-fixture.mjs';
import { cursorLine, waitCursor } from './nav-history-fixture.mjs';

const LINES = 80;
const body = (stem, changedAt = 0) =>
  `${Array.from({ length: LINES }, (_, i) =>
    i + 1 === changedAt
      ? `export const ${stem}${i + 1} = 'changed';`
      : `export const ${stem}${i + 1} = ${i + 1};`,
  ).join('\n')}\n`;

const basename = (p) => p.split('/').pop();

async function waitDocTab(page, kind, title, what) {
  const found = await page
    .waitForFunction(
      ({ kind, title }) =>
        Array.from(document.querySelectorAll(`.tabbar [role="tab"][data-tabid^="${kind}:"]`)).some(
          (el) => el.querySelector('span')?.textContent === title,
        ),
      { kind, title },
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
  const tabs = await tabInfo(page);
  assert(
    found,
    `${what}: no ${kind} tab titled "${title}" appeared (tabs: ${JSON.stringify(tabs.map((t) => t.title))})`,
  );
  return page.evaluate(
    ({ kind, title }) => {
      const el = Array.from(
        document.querySelectorAll(`.tabbar [role="tab"][data-tabid^="${kind}:"]`),
      ).find((e) => e.querySelector('span')?.textContent === title);
      return {
        id: el.getAttribute('data-tabid'),
        active: el.classList.contains('tab--active'),
        preview: el.classList.contains('tab--preview'),
      };
    },
    { kind, title },
  );
}

/** The Review's own state a middle-click must not touch: the hunk cursor and the scroller. */
function reviewState(page) {
  return page.evaluate(() => ({
    current: Array.from(document.querySelectorAll('.review [aria-current="true"]'))
      .map(
        (el) =>
          `${el.closest('.rcard')?.getAttribute('data-path')}#${el.getAttribute('data-hunk') ?? 'card'}`,
      )
      .join('|'),
    scrollTop: document.querySelector('.review__scroll')?.scrollTop ?? null,
  }));
}

// A reveal or a windowing pass lands a frame or two after the triggering action; the hidden
// window throttles frames, so a baseline taken too early would blame the middle-click for it.
async function settle(page) {
  let prev = JSON.stringify([await snapshotUnchanged(page), await reviewState(page)]);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const next = JSON.stringify([await snapshotUnchanged(page), await reviewState(page)]);
    if (next === prev) return;
    prev = next;
  }
}

async function assertBackground(page, before, tab, what) {
  assert(!tab.active, `${what}: the new tab must open in the background, not become active`);
  assert(!tab.preview, `${what}: a middle-clicked target opens pinned, not as the preview`);
  const diff = sameSnapshot(before, await snapshotUnchanged(page));
  assert(diff === null, `${what}: a background open changed: ${diff}`);
}

runScenario('middle-click-review', async ({ app, page, log }) => {
  const root = writeFixtureRepo({
    files: { 'a.ts': body('a'), 'b.ts': body('b'), 'c.txt': 'c\n', 'd.txt': 'd\n' },
    commits: [{ 'c.txt': 'c changed\n', 'd.txt': 'd changed\n' }],
    dirty: { 'a.ts': body('a', 40), 'b.ts': body('b', 40) },
  });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  await openSession(page, { path: root });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  const cardsReady = await page
    .waitForFunction(
      () =>
        !!document.querySelector('.review .rcard[data-path="a.ts"] .rhunk__jump') &&
        !!document.querySelector('.review .rcard[data-path="b.ts"] .rhunk__jump'),
      null,
      { timeout: 20000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert(cardsReady, 'setup: both modified files must render a Review card with a hunk');
  const reviewTitle = (await snapshotUnchanged(page)).activeTitle;
  assert(reviewTitle, 'setup: the Review tab must be the active tab');

  if (!(await reviewState(page)).current) {
    await page.focus('.review__scroll');
    await page.keyboard.press('j');
  }
  const hasCurrent = await page
    .waitForFunction(() => !!document.querySelector('.review .rhunk__jump--current'), null, {
      timeout: 5000,
    })
    .then(
      () => true,
      () => false,
    );
  assert(hasCurrent, 'setup: the Review must have a current hunk before S7');
  const currentPath = await page.evaluate(() =>
    document
      .querySelector('.review .rhunk__jump--current')
      ?.closest('.rcard')
      ?.getAttribute('data-path'),
  );
  const otherPath = currentPath === 'a.ts' ? 'b.ts' : 'a.ts';
  const card = (p) => page.locator(`.review .rcard[data-path="${p}"]`);

  // S5: card "open" → file tab, background
  await card(currentPath).locator('.rcard__open').scrollIntoViewIfNeeded();
  await settle(page);
  let before = await snapshotUnchanged(page);
  await middleClickJitter(page, card(currentPath).locator('.rcard__open'));
  let tab = await waitDocTab(page, 'file', basename(currentPath), 'S5');
  await assertBackground(page, before, tab, 'S5');
  log(`S5 card open → background file tab ${currentPath} ✓`);

  // S6: card side-by-side → diff tab, background
  await card(currentPath).locator('.rcard__sbs').scrollIntoViewIfNeeded();
  await settle(page);
  before = await snapshotUnchanged(page);
  await middleClickJitter(page, card(currentPath).locator('.rcard__sbs'));
  tab = await waitDocTab(page, 'diff', basename(currentPath), 'S6');
  await assertBackground(page, before, tab, 'S6');
  log(`S6 card side-by-side → background diff tab ${currentPath} ✓`);

  // S7: hunk jump on the other card → file tab, background, current hunk untouched
  const jump = card(otherPath).locator('.rhunk__jump').first();
  const hunkText = (await jump.textContent()) ?? '';
  const hunkLine = Number(/\+(\d+),/.exec(hunkText)?.[1]);
  assert(hunkLine > 1, `S7 setup: could not read the hunk's start line from "${hunkText}"`);
  await jump.scrollIntoViewIfNeeded();
  await settle(page);
  before = await snapshotUnchanged(page);
  const reviewBefore = await reviewState(page);
  await middleClickJitter(page, jump);
  tab = await waitDocTab(page, 'file', basename(otherPath), 'S7');
  await assertBackground(page, before, tab, 'S7');
  const reviewAfter = await reviewState(page);
  assert(
    reviewAfter.current === reviewBefore.current,
    `S7: the Review's current hunk moved: ${reviewBefore.current} → ${reviewAfter.current}`,
  );
  assert(
    reviewAfter.scrollTop === reviewBefore.scrollTop,
    `S7: the Review scrolled: ${reviewBefore.scrollTop} → ${reviewAfter.scrollTop}`,
  );
  log(`S7 hunk jump → background file tab ${otherPath}, current hunk unchanged ✓`);

  // S8: History commit file row → pinned commit-diff tab, background
  await page.click('.git-indicator__history', { force: true });
  await page.waitForSelector('.gh__row', { state: 'attached', timeout: 15000 });
  await page
    .locator('.gh__row', { has: page.locator('.gh__subject', { hasText: /^change 1$/ }) })
    .first()
    .click();
  const filesReady = await page
    .waitForFunction(
      () => document.querySelectorAll('.gh__detail .commitview .gh__file').length >= 2,
      null,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert(filesReady, 'S8 setup: the commit detail must list both changed files');
  const historyTitle = (await snapshotUnchanged(page)).activeTitle;
  assert(historyTitle === 'History', `S8 setup: History must be active (got ${historyTitle})`);
  const fileRow = page.locator('.gh__detail .commitview .gh__file', {
    has: page.locator('.gh__file-path', { hasText: /^c\.txt$/ }),
  });
  await fileRow.scrollIntoViewIfNeeded();
  await settle(page);
  before = await snapshotUnchanged(page);
  await middleClickJitter(page, fileRow);
  const commitTitle = `c.txt @ ${sha.slice(0, 7)}`;
  tab = await waitDocTab(page, 'commit-diff', commitTitle, 'S8');
  assert(
    tab.id === `commit-diff:${sha} c.txt`,
    `S8: the commit-diff tab must be the pinned identity, not the preview slot (id ${tab.id})`,
  );
  await assertBackground(page, before, tab, 'S8');
  log(`S8 commit file row → pinned background commit-diff tab "${commitTitle}" ✓`);

  // AC-4: the background hunk tab opens at the hunk when first activated
  await page
    .locator(`.tabbar [role="tab"][data-tabid^="file:"]`, {
      has: page.locator('span', {
        hasText: new RegExp(`^${basename(otherPath).replace('.', '\\.')}$`),
      }),
    })
    .first()
    .click();
  const activated = await page
    .waitForFunction(
      (t) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === t,
      basename(otherPath),
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert(activated, `AC-4: clicking the ${otherPath} tab must activate it`);
  const atHunk = await waitCursor(page, hunkLine, 15000);
  assert(
    atHunk,
    `AC-4: ${otherPath} must open at the hunk's line ${hunkLine} (cursor at ${await cursorLine(page)})`,
  );
  log(`AC-4 activating ${otherPath} lands on line ${hunkLine} ✓`);

  await closeApp(app, page);
});

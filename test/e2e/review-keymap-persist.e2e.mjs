/**
 * Review keyboard model + durable reviewed marks (real-app smoke, spec
 * 2026-08-27-review-supercharge §7 Lane B). Two launches against ONE user-data dir, because the
 * whole point is that a mark outlives the process: it is written to userData/review-marks.json by
 * the main process and pushed back to a fresh renderer on `ready`.
 *
 * Also covers the four pieces of polish that only exist in the real app: the sticky file header
 * (a CSS scrollport question no unit test can answer), the oversize diff's "Open file" button, the
 * ignore-whitespace toggle, and the source picker's quick-pick rows — which are HIDDEN here on
 * purpose: the fixture has no remote and no branch of its own, so `git:resolveRange` fails for
 * both presets and only "Last commit" may appear.
 *
 * Windows only. Run it ALONE on a quiet machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[review-keymap-persist] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('review-keymap-persist');
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'conduit-rkp-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-rkp-ud-'));

const committed = {
  // Three changes far enough apart to become three separate hunks — that is what j/k walk.
  'alpha.ts': `${lines(40, (i) => `const a${i} = ${i};`)}\n`,
  'beta.ts': `${lines(8, (i) => `export const b${i} = ${i};`)}\n`,
  // Only ever re-indented — the ignore-whitespace case.
  'indent.ts': 'function f() {\nreturn 1;\n}\n',
  // Tall enough, once uncapped, to scroll THROUGH — the sticky-header case.
  'long.ts': `${lines(200, (i) => `const L${i} = ${i};`)}\n`,
  // Past readDiff's 2 MB cap — the oversize "Open file" case.
  'huge.ts': `${lines(60_000, (i) => `// padding line ${i} ${'x'.repeat(30)}`)}\n`,
};

git(root, 'init', '-q');
for (const [f, c] of Object.entries(committed)) writeFileSync(join(root, f), c);
git(root, 'add', '.');
git(root, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');

const alphaChanged = committed['alpha.ts']
  .replace('const a5 = 5;', 'const a5 = 500;')
  .replace('const a20 = 20;', 'const a20 = 2000;')
  .replace('const a35 = 35;', 'const a35 = 3500;');
writeFileSync(join(root, 'alpha.ts'), alphaChanged);
writeFileSync(join(root, 'beta.ts'), committed['beta.ts'].replace('b3 = 3', 'b3 = 300'));
writeFileSync(join(root, 'indent.ts'), 'function f() {\n    return 1;\n}\n');
writeFileSync(
  join(root, 'long.ts'),
  `${lines(200, (i) => (i % 3 === 0 ? `const L${i} = ${i * 2};` : `const L${i} = ${i};`))}\n`,
);
writeFileSync(join(root, 'huge.ts'), `${committed['huge.ts']}// one more line\n`);

const porcelainBefore = git(root, 'status', '--porcelain');
log(`fixture: ${root}`);

// ── Launch plumbing (two launches, one profile — see test/e2e/durability.e2e.mjs) ───────────────
const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  return { app, page };
}

/** Open the fixture repo and put the Review tab on screen with its cards rendered. */
async function openReview(page) {
  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 20000 });
  // Every mark control is gated on the first review:marks push; nothing below may click early.
  await page.waitForFunction(
    () => document.querySelector('.review__check')?.disabled === false,
    null,
    {
      timeout: 15000,
    },
  );
}

const focusScroller = (page) =>
  page.evaluate(() => document.querySelector('.review__scroll')?.focus());

/** { path, hunk } of whatever currently carries the ring inside the card list. */
const ring = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.review__scroll [aria-current="true"]');
    if (!el) return null;
    return {
      path: el.closest('.rcard')?.getAttribute('data-path') ?? null,
      hunk: el.getAttribute('data-hunk'),
    };
  });

const meter = (page) => page.textContent('.review__count').then((t) => (t ?? '').trim());

const scrollToCard = async (page, path) => {
  await page.locator(`.review__nav .review__navrow[data-path="${path}"] .review__navbtn`).click();
  await page.waitForSelector(`.review .rcard[data-path="${path}"]`, { timeout: 10000 });
};

/** A card can only be marked once its diff has streamed in (the load gate, §12 assumption 8). */
const waitMarkable = (page, path) =>
  page.waitForFunction(
    (p) => {
      const btn = document.querySelector(`.rcard[data-path="${p}"] .rcard__reviewed`);
      return !!btn && !btn.disabled;
    },
    path,
    { timeout: 15000 },
  );

let firstApp;
let secondApp;
const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
try {
  // ── Launch 1 ─────────────────────────────────────────────────────────────────────────────────
  const first = await launch();
  firstApp = first.app;
  const page = first.page;
  await openReview(page);
  log('Review open with the fixture changeset ✓');

  // (1) j / k walk hunks INSIDE a file; J / K walk files. Both wrap.
  await focusScroller(page);
  await page.keyboard.press('j');
  await page.waitForFunction(
    () => !!document.querySelector('.review__scroll [aria-current="true"]'),
    null,
    { timeout: 8000 },
  );
  const r1 = await ring(page);
  assert(r1?.path, `j must put the ring on a hunk header; got ${JSON.stringify(r1)}`);
  await page.keyboard.press('j');
  const r2 = await ring(page);
  assert(
    r2 && (r2.path !== r1.path || r2.hunk !== r1.hunk),
    `a second j must move the ring; stayed at ${JSON.stringify(r1)}`,
  );
  await page.keyboard.press('k');
  const r3 = await ring(page);
  assert(
    r3 && r3.path === r1.path && r3.hunk === r1.hunk,
    `k must undo j; ${JSON.stringify(r3)} !== ${JSON.stringify(r1)}`,
  );
  await page.keyboard.press('J');
  const r4 = await ring(page);
  assert(r4 && r4.path !== r1.path, `J must move to another FILE; stayed on ${r1.path}`);
  await page.keyboard.press('K');
  const r5 = await ring(page);
  assert(r5 && r5.path === r1.path, `K must come back to ${r1.path}; got ${r5?.path}`);
  log(`j/k/J/K move the ring (${r1.path} #${r1.hunk} ⇄ ${r4.path}) ✓`);

  // (2) `?` opens the help panel and Esc closes it WITHOUT closing Review.
  await page.keyboard.press('?');
  await page.waitForSelector('.review__help', { state: 'visible', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.review__help', { state: 'detached', timeout: 5000 });
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 5000 });
  log('? opens the key list; Esc closes it and leaves Review open ✓');

  // (3) `m` marks the file the ring is on; the navigator checkbox marks another.
  assert(
    (await meter(page)) === '0 / 5 reviewed',
    `meter should start empty; got "${await meter(page)}"`,
  );
  await scrollToCard(page, 'alpha.ts');
  await focusScroller(page);
  await page.keyboard.press('J'); // land the ring somewhere deterministic first
  await page.evaluate(() => {
    const el = document.querySelector('.review__scroll [aria-current="true"]');
    el?.closest('.rcard')?.setAttribute('data-ringed', '1');
  });
  const markedByKey = await page.evaluate(
    () => document.querySelector('.rcard[data-ringed="1"]')?.getAttribute('data-path') ?? '',
  );
  assert(markedByKey, 'the ring must sit inside a card before pressing m');
  await waitMarkable(page, markedByKey);
  await focusScroller(page);
  await page.keyboard.press('m');
  await page.waitForFunction(
    () => /^1 \/ 5 reviewed$/.test(document.querySelector('.review__count')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  await page.locator('.review__nav .review__navrow[data-path="alpha.ts"] .review__check').click();
  await page.waitForFunction(
    () => /^2 \/ 5 reviewed$/.test(document.querySelector('.review__count')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  log(`m marked "${markedByKey}"; the checkbox marked alpha.ts ✓`);

  // (4) Collapse all / Expand all.
  await page.click('.review__collapseall');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.review__scroll .rcard__toggle')].every(
        (b) => b.getAttribute('aria-expanded') === 'false',
      ),
    null,
    { timeout: 8000 },
  );
  assert(
    (await page.getAttribute('.review__collapseall', 'aria-pressed')) === 'true',
    'Collapse all must report itself pressed',
  );
  await page.click('.review__expandall');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.review__scroll .rcard__toggle')].every(
        (b) => b.getAttribute('aria-expanded') === 'true',
      ),
    null,
    { timeout: 8000 },
  );
  log('Collapse all / Expand all reach every mounted card ✓');

  // (5) The file header sticks while you scroll THROUGH a long card.
  await scrollToCard(page, 'long.ts');
  await page.locator('.rcard[data-path="long.ts"] .rcard__showrest').click();
  await page.evaluate(() => {
    const el = document.querySelector('.review__scroll');
    if (el) el.scrollTop += 400;
  });
  await page.waitForTimeout(200);
  const stuck = await page.evaluate(() => {
    const card = document.querySelector('.rcard[data-path="long.ts"]');
    const head = card?.querySelector('.rcard__head');
    const scroll = document.querySelector('.review__scroll');
    if (!card || !head || !scroll) return null;
    return {
      card: card.getBoundingClientRect().top,
      head: head.getBoundingClientRect().top,
      port: scroll.getBoundingClientRect().top,
    };
  });
  assert(stuck, 'long.ts card, its header and the scroller must all be present');
  assert(
    stuck.card < stuck.port - 20,
    `the card's own top must be scrolled above the viewport; card ${stuck.card} vs port ${stuck.port}`,
  );
  assert(
    Math.abs(stuck.head - stuck.port) < 8,
    `the file header must stay pinned at the scroller's top; head ${stuck.head} vs port ${stuck.port}`,
  );
  log('the file header stays pinned while its card scrolls past ✓');

  // (6) Ignore whitespace hides an indent-only change.
  await scrollToCard(page, 'indent.ts');
  await page.click('.review__wstoggle');
  await page.waitForFunction(
    () =>
      (document.querySelector('.rcard[data-path="indent.ts"]')?.textContent ?? '').includes(
        'No textual changes.',
      ),
    null,
    { timeout: 8000 },
  );
  await page.click('.review__wstoggle');
  await page.waitForFunction(
    () => !!document.querySelector('.rcard[data-path="indent.ts"] .rhunk'),
    null,
    { timeout: 8000 },
  );
  log('ignore-whitespace hides an indent-only change and restores it ✓');

  // (7) The source picker offers Last commit, and hides the two rows this repo can't resolve.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker__row', { state: 'visible', timeout: 10000 });
  // Both presets need a round trip; give the replies a beat before asserting an ABSENCE.
  await page.waitForTimeout(600);
  const pickerText = await page.textContent('.commit-picker__list');
  assert(pickerText.includes('Last commit'), 'the picker must offer Last commit');
  assert(!pickerText.includes('Unpushed'), 'a repo with no upstream must not offer Unpushed');
  assert(
    !pickerText.includes('Since branch point'),
    'a repo that IS its default branch must not offer Since branch point',
  );
  // Close by re-clicking the trigger: Escape here would also reach Review's own handler.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker__row', { state: 'detached', timeout: 8000 });
  log('picker shows Last commit only ✓');

  // (8) The marks file exists, and marking left the repo alone.
  const marksPath = join(userDataDir, 'review-marks.json');
  assert(existsSync(marksPath), `review-marks.json was not written to ${userDataDir}`);
  const stored = JSON.parse(readFileSync(marksPath, 'utf8'));
  assert(stored.version === 1, `marks file version should be 1; got ${stored.version}`);
  assert(
    git(root, 'status', '--porcelain') === porcelainBefore,
    'marking a file reviewed must not change anything in the repo',
  );
  assert(!existsSync(join(root, '.conduit')), 'marks must never be written into the project');
  log('marks live in userData and the repo is untouched ✓');

  // (9) The oversize notice's "Open file" opens the file. Done LAST: it leaves the Review tab.
  await scrollToCard(page, 'huge.ts');
  await page.locator('.rcard[data-path="huge.ts"] .rcard__split').click();
  await page.waitForSelector('.viewer__notice--oversize .viewer__notice-action', {
    timeout: 20000,
  });
  await page.click('.viewer__notice--oversize .viewer__notice-action');
  await page.waitForFunction(
    () =>
      (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith('huge.ts')),
    null,
    { timeout: 25000 },
  );
  log('the oversize notice’s Open file button opens the file ✓');

  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'review-keymap-persist-1.png') }).catch(() => {});

  await closeApp(firstApp, page);
  firstApp = null;
  log('first launch closed (before-quit flushed review-marks.json)');

  // ── Between launches: one of the two marked files changes on disk ───────────────────────────
  writeFileSync(join(root, 'beta.ts'), committed['beta.ts'].replace('b3 = 3', 'b3 = 999'));

  // ── Launch 2 ─────────────────────────────────────────────────────────────────────────────────
  const second = await launch();
  secondApp = second.app;
  const page2 = second.page;
  await openReview(page2);

  await page2.waitForFunction(
    () => /^1 \/ 5 reviewed$/.test(document.querySelector('.review__count')?.textContent ?? ''),
    null,
    { timeout: 20000 },
  );
  const survived = await page2.evaluate(() => ({
    alpha: document.querySelector(
      '.review__nav .review__navrow[data-path="alpha.ts"] .review__check',
    )?.checked,
    beta: document.querySelector('.review__nav .review__navrow[data-path="beta.ts"] .review__check')
      ?.checked,
  }));
  assert(survived.alpha === true, 'an unchanged file must still read as reviewed after a restart');
  assert(survived.beta === false, 'a file that changed since must lose its mark');
  log('marks survived the restart; the changed file retired its own ✓');

  await page2.screenshot({ path: join(shotDir, 'review-keymap-persist-2.png') }).catch(() => {});
  await closeApp(secondApp, page2);
  secondApp = null;

  log('PASS ✓ review-keymap-persist');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[review-keymap-persist] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    if (firstApp) await firstApp.close();
    if (secondApp) await secondApp.close();
  } catch {
    /* already gone */
  }
  process.exit(isAssertion ? 1 : 2);
}

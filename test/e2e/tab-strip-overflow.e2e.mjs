/**
 * tab-strip-overflow — an overflowing tab strip keeps its layout (split-editor review L5.5).
 *
 * `* { scrollbar-color }` makes Chromium ignore `.tabbar::-webkit-scrollbar`, so an overflowing
 * strip drew a classic 15px scrollbar that took layout height, and centring lifted its tabs by
 * half of it (and clipped Neon's top accent). In each theme, on a fresh profile (a hidden window
 * doesn't repaint on a live theme swap):
 *   OV1 one group, no overflow → baseline tab top and strip height
 *   OV2 one group, overflowing → the same tab top and strip height
 *   WH  a real wheel over the strip scrolls it back to its start and on until the last tab is
 *       fully in view — the strip draws no scrollbar, so the wheel and the chevron are the only
 *       ways along it
 *   PK  picking a scrolled-out tab from the overflow chevron's list brings it fully into view
 *       (WH and PK in the first theme only: nothing themed scrolls the strip, and every real-input
 *       step in a hidden window costs seconds against the runner's cap)
 *   OV3 two groups, the left overflowing and the right not → every tab on both strips at the
 *       baseline top, both strips at the baseline height
 * With CONDUIT_SHOTS_DIR set, one screenshot per theme of the split strips is written there.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, removeDir } from './harness.mjs';
import { G, groupCount, openFromExplorer, sleep, waitShown } from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[tab-strip-overflow] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('tab-strip-overflow');
const THEMES = ['aero', 'aero-dark', 'neon'];
const SHOTS = process.env.CONDUIT_SHOTS_DIR;

const repo = mkdtempSync(join(tmpdir(), 'conduit-strip-overflow-'));
const NAMES = Array.from({ length: 9 }, (_, i) => `a-long-module-name-for-overflow-${i + 1}.ts`);
for (const n of NAMES) writeFileSync(join(repo, n), `export const v = ${n.length};\n`);
const repoArg = repo.replace(/\\/g, '/');

/** Group 1's strip: its scroll offset and whether the tab titled `name` is wholly inside it. */
const stripView = (page, name) =>
  page.evaluate((n) => {
    const strip = document.querySelector('.editor-group[data-group="1"] .tabbar');
    const s = strip.getBoundingClientRect();
    const tab = [...strip.querySelectorAll('[role="tab"]')].find(
      (t) => t.querySelector('span')?.textContent === n,
    );
    const t = tab?.getBoundingClientRect();
    return {
      scrollLeft: strip.scrollLeft,
      inView: !!t && t.left >= s.left - 0.5 && t.right <= s.right + 0.5,
    };
  }, name);

async function pollView(page, name, until, tries = 30) {
  let v = await stripView(page, name);
  for (let i = 0; i < tries && !until(v); i++) {
    await sleep(100);
    v = await stripView(page, name);
  }
  return v;
}

/** Wheels wherever the mouse is until `until` holds or three wheels in a row don't move the strip. */
async function wheelUntil(page, name, dy, until) {
  let v = await stripView(page, name);
  for (let i = 0, stalls = 0; i < 40 && stalls < 3 && !until(v); i++) {
    const prev = v.scrollLeft;
    await page.mouse.wheel(0, dy);
    v = await pollView(page, name, (w) => w.scrollLeft !== prev, 5);
    stalls = v.scrollLeft === prev ? stalls + 1 : 0;
  }
  return v;
}

/** Per strip: overflow, the strip row's height, and the top of every tab it paints. */
const strips = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.editor-group')].map((grp) => {
      const strip = grp.querySelector('.tabbar');
      const wrap = grp.querySelector('.tabbar-wrap');
      const s = strip.getBoundingClientRect();
      const tops = [...strip.querySelectorAll('[data-tabid]')]
        .map((t) => t.getBoundingClientRect())
        .filter((r) => r.right > s.left && r.left < s.right)
        .map((r) => Math.round(r.top * 10) / 10);
      return {
        overflowing: strip.scrollWidth > strip.clientWidth + 1,
        height: Math.round(wrap.getBoundingClientRect().height * 10) / 10,
        stripHeight: Math.round(s.height * 10) / 10,
        tops,
      };
    }),
  );

/** WH and PK: the strip has scrolled to `last`, the tab just opened. */
async function scrollAlong(page, theme, last) {
  const box = await page.locator(`${G(1)} .tabbar`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const start = await stripView(page, last);
  const home = await wheelUntil(page, last, -300, (v) => v.scrollLeft === 0);
  log(theme, 'WH home', JSON.stringify(start), JSON.stringify(home));
  assert(
    home.scrollLeft === 0,
    `${theme} WH: wheeling up stopped at scrollLeft ${home.scrollLeft}`,
  );
  assert(!home.inView, `${theme} WH: ${last} is still in view at the strip's start`);
  const end = await wheelUntil(page, last, 300, (v) => v.inView);
  log(theme, 'WH end', JSON.stringify(end));
  assert(end.scrollLeft > 0, `${theme} WH: wheeling down left scrollLeft at 0`);
  assert(end.inView, `${theme} WH: the wheel never brought ${last} fully into view`);

  assert(
    !(await stripView(page, NAMES[0])).inView,
    `${theme} PK: ${NAMES[0]} is still in view with the strip wheeled to its end`,
  );
  await page.locator(`${G(1)} .tabbar__overflow-btn`).click();
  await page
    .locator('.ctxmenu__item', { hasText: NAMES[0] })
    .click({ timeout: 5000 })
    .catch(() => assert(false, `${theme} PK: the chevron list has no ${NAMES[0]}`));
  const picked = await pollView(page, NAMES[0], (v) => v.inView);
  log(theme, 'PK', JSON.stringify(picked));
  assert(picked.inView, `${theme} PK: picking ${NAMES[0]} did not scroll it into view`);

  await page.locator(`${G(1)} [role="tab"]`, { hasText: last }).click();
  await page
    .waitForFunction(
      (n) =>
        document.querySelector('.editor-group[data-group="1"] .tab--active span')?.textContent ===
        n,
      last,
      { timeout: 5000 },
    )
    .catch(() => assert(false, `${theme} PK: clicking ${last} did not activate it`));
}

async function runTheme(theme) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-strip-ud-'));
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ version: 1, settings: { theme, restoreSessions: false } }),
  );
  try {
    await runOn(theme, userDataDir);
  } finally {
    await removeDir(userDataDir, { budgetMs: 10000 });
  }
}

async function runOn(theme, userDataDir) {
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await openSession(page, { path: repoArg });
    assert(
      (await page.evaluate(() => document.documentElement.dataset.theme)) === theme,
      `${theme}: the profile did not start on ${theme}`,
    );

    await openFromExplorer(page, NAMES[0]);
    const [base] = await strips(page);
    log(theme, 'OV1', JSON.stringify(base));
    assert(!base.overflowing, `${theme} OV1: one tab already overflows the strip`);
    const top = base.tops[0];
    assert(
      base.tops.every((t) => t === top),
      `${theme} OV1: tabs differ in top ${base.tops}`,
    );

    let one = base;
    let last = NAMES[0];
    for (const n of NAMES.slice(1)) {
      await openFromExplorer(page, n);
      last = n;
      [one] = await strips(page);
      if (one.overflowing && !(await stripView(page, NAMES[0])).inView) break;
    }
    log(theme, 'OV2', JSON.stringify(one));
    assert(one.overflowing, `${theme} OV2: ${NAMES.length} tabs did not overflow the strip`);
    assert(
      one.height === base.height && one.stripHeight === base.stripHeight,
      `${theme} OV2: the strip is ${one.height}/${one.stripHeight}px overflowing, ${base.height}/${base.stripHeight}px not`,
    );
    assert(
      one.tops.every((t) => t === top),
      `${theme} OV2: overflowing tab tops ${one.tops}, not ${top}`,
    );

    if (theme === THEMES[0]) await scrollAlong(page, theme, last);

    await page.locator(`${G(1)} .monaco-editor`).click();
    await page.keyboard.press('Control+Backslash');
    await page
      .waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
        timeout: 10000,
      })
      .catch(() => assert(false, `${theme} OV3: Ctrl+\\ did not split`));
    await waitShown(page, 2, last, `${theme} OV3`);
    const pair = await strips(page);
    log(theme, 'OV3', JSON.stringify(pair));
    assert((await groupCount(page)) === 2, `${theme} OV3: expected two groups`);
    assert(
      pair[0].overflowing && !pair[1].overflowing,
      `${theme} OV3: expected the left strip overflowing and the right not`,
    );
    for (const [i, s] of pair.entries()) {
      assert(
        s.height === base.height && s.stripHeight === base.stripHeight,
        `${theme} OV3: group ${i + 1}'s strip is ${s.height}/${s.stripHeight}px, not ${base.height}/${base.stripHeight}px`,
      );
      assert(
        s.tops.every((t) => t === top),
        `${theme} OV3: group ${i + 1}'s tab tops ${s.tops}, not ${top}`,
      );
    }

    if (SHOTS) {
      const box = await page.locator('.editorgroups').boundingBox();
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({
        path: join(SHOTS, `overflow-${theme}.png`),
        clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 120) },
      });
    }
    log(`${theme} ✓ strip layout holds with and without overflow`);
  } finally {
    await launched.cleanup();
  }
}

let code = 0;
try {
  for (const theme of THEMES) await runTheme(theme);
  log('PASS ✓ tab-strip-overflow: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[tab-strip-overflow] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[tab-strip-overflow] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await removeDir(repo, { budgetMs: 10000 });
} catch (e) {
  console.error('[tab-strip-overflow] ERROR: the fixture repo was not removed:', e?.message || e);
  code ||= 2;
}
process.exit(code);

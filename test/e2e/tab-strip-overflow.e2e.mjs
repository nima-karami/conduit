/**
 * tab-strip-overflow — an overflowing tab strip keeps its layout (split-editor review L5.5).
 *
 * `* { scrollbar-color }` makes Chromium ignore `.tabbar::-webkit-scrollbar`, so an overflowing
 * strip drew a classic 15px scrollbar that took layout height, and centring lifted its tabs by
 * half of it (and clipped Neon's top accent). In each theme, on a fresh profile (a hidden window
 * doesn't repaint on a live theme swap):
 *   OV1 one group, no overflow → baseline tab top and strip height
 *   OV2 one group, overflowing → the same tab top and strip height
 *   OV3 two groups, the left overflowing and the right not → every tab on both strips at the
 *       baseline top, both strips at the baseline height
 * With CONDUIT_SHOTS_DIR set, one screenshot per theme of the split strips is written there.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession } from './harness.mjs';
import { G, groupCount, openFromExplorer, waitShown } from './split-editor-helpers.mjs';

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

async function runTheme(theme) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-strip-ud-'));
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ version: 1, settings: { theme, restoreSessions: false } }),
  );
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
      if (one.overflowing) break;
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
process.exit(code);

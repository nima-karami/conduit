/**
 * Shared driver for the tree-chevrons scenarios, one theme each: the Files folder bar and the
 * Changes repo head lead with the same left-hand chevron on one column with the depth-0 tree
 * rows, Changes rows take the Files row metrics, and a collapsed Changes repo survives a tab
 * switch. docs/specs/2026-09-28-tree-chevrons.md §7 AC1–AC10, AC12 (geometry), AC13 — geometry
 * is layout, so only the running app can prove it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitBase, git } from './changes-fixture.mjs';
import {
  assert,
  finishScenario,
  launchApp,
  makeLog,
  openChangesTab,
  openSession,
  profileDir,
  removeDir,
} from './harness.mjs';

const NAME = 'tree-chevrons';
const log = makeLog(NAME);

const OPEN = 'matrix(0, 1, -1, 0, 0, 0)';
const near = (a, b) => Math.abs(a - b) <= 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo(dir) {
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  writeFileSync(join(dir, 'src', 'deep', 'a.ts'), 'export const a = 1;\n');
  commitBase(dir);
  writeFileSync(join(dir, 'src', 'deep', 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
  git(dir, 'add', 'src/new.ts');
}

async function showTab(page, name) {
  if (name === 'Changes') return openChangesTab(page);
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.files__bar', { state: 'visible', timeout: 15000 });
}

/** Rect of the first element matching `sel` (optionally under the nth match of `scope`). */
const rect = (page, sel, scope, n = 0) =>
  page.evaluate(
    ({ s, sc, i }) => {
      const base = sc ? document.querySelectorAll(sc)[i] : document;
      const r = base?.querySelector(s)?.getBoundingClientRect();
      return r
        ? { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }
        : null;
    },
    { s: sel, sc: scope ?? null, i: n },
  );
const cx = (r) => r.left + r.width / 2;

/** The depth-0 folder row (`src`) and the depth-0 file row (`README.md`) of the home section. */
const depth0 = (page) =>
  page.evaluate(() => {
    const tree = document.querySelector('.files-section__tree');
    const rows = [...(tree?.querySelectorAll('.filerow[aria-level="1"]') ?? [])];
    const box = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { left: r.left, width: r.width, height: r.height } : null;
    };
    const folder = rows.find((r) => r.querySelector('.treechev'));
    const file = rows.find((r) => !r.querySelector('.treechev'));
    return {
      folderChev: box(folder?.querySelector('.treechev')),
      file: box(file),
      fileIcon: box(file?.children[1]),
      fileRadius: file ? getComputedStyle(file).borderRadius : null,
    };
  });

/** aria-expanded of the header toggle for `label` in the current tab. */
const expanded = (page, label) =>
  page.evaluate((l) => {
    const files = [...document.querySelectorAll('.files__bar')].find(
      (b) => b.querySelector('.files__root-name')?.textContent === l,
    );
    const head = [...document.querySelectorAll('.repo-head')].find(
      (h) => h.querySelector('.repo-head__name')?.textContent === l,
    );
    return (
      (
        files?.querySelector('.files__collapse') ?? head?.querySelector('.repo-head__chev')
      )?.getAttribute('aria-expanded') ?? null
    );
  }, label);

const toggleSel = (label, tab) =>
  tab === 'Files'
    ? `.files__collapse[aria-label$=" ${label}"]`
    : `.repo-head[aria-label^="${label},"] .repo-head__chev`;

async function pickView(page, label) {
  await page.click('.changes__kebab');
  await page.locator('.ctxmenu__item', { hasText: label }).click();
  await sleep(300);
}

/** Every `.treechev` in the current tab: its width and transform against its toggle's state. */
const chevStates = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.treechev')].map((c) => {
      const owner = c.closest('[aria-expanded]');
      return {
        width: c.getBoundingClientRect().width,
        open: owner?.getAttribute('aria-expanded') === 'true',
        owner: owner?.className ?? null,
        transform: getComputedStyle(c).transform,
      };
    }),
  );

async function setBarWidth(page, target) {
  for (let i = 0; i < 3; i++) {
    const bar = await rect(page, '.files__bar, .repo-head');
    const cur = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--right-w')),
    );
    const next = cur - (bar.width - target);
    await page.evaluate(
      (w) => document.documentElement.style.setProperty('--right-w', `${w}px`),
      next,
    );
    await sleep(150);
  }
  return (await rect(page, '.files__bar, .repo-head')).width;
}

/** No other visible header child's rect intersects a header's chevron. */
const chevronClear = (page, headSel) =>
  page.evaluate((hs) => {
    const bad = [];
    for (const head of document.querySelectorAll(hs)) {
      const chev = head.querySelector('.treechev')?.getBoundingClientRect();
      if (!chev) continue;
      for (const kid of head.children) {
        if (kid.contains(head.querySelector('.treechev'))) continue;
        const r = kid.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(kid).display === 'none') continue;
        const hit =
          r.left < chev.right && r.right > chev.left && r.top < chev.bottom && r.bottom > chev.top;
        if (hit) bad.push(kid.className);
      }
    }
    return bad;
  }, headSel);

async function runTheme(theme) {
  const work = mkdtempSync(join(tmpdir(), 'conduit-tc-'));
  const home = join(work, 'home');
  const ref = join(work, 'ref');
  makeRepo(home);
  makeRepo(ref);
  const userDataDir = profileDir('tc');
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ version: 1, settings: { theme, restoreSessions: false } }),
  );
  const launched = await launchApp({ userDataDir });
  const { page } = launched;
  const t = (msg) => `[${theme}] ${msg}`;
  try {
    await openSession(page, { path: home, roots: [home, ref] });
    await openChangesTab(page);
    await page.waitForSelector('.change', { timeout: 20000 });
    await showTab(page, 'Files');
    await page.waitForSelector('.files-section__tree .filerow', { timeout: 15000 });

    // AC1
    const ac1 = await page.evaluate(() =>
      [...document.querySelectorAll('.files__bar')].map((b) => {
        const first = b.firstElementChild;
        return {
          isCollapse: first?.matches('button.files__collapse') ?? false,
          chevLeft: first?.getBoundingClientRect().left ?? 0,
          iconLeft: b.querySelector('.files__root-icon')?.getBoundingClientRect().left ?? 0,
        };
      }),
    );
    assert(ac1.length === 2, t(`two Files bars: ${ac1.length}`));
    for (const b of ac1) {
      assert(b.isCollapse, t('AC1 collapse button is the first child of .files__bar'));
      assert(b.chevLeft < b.iconLeft, t('AC1 chevron left of the folder glyph'));
    }

    // AC2 / AC3 (Files side) / AC6 (Files side)
    const filesChev = await rect(page, '.files__bar .treechev');
    const filesIcon = await rect(page, '.files__root-icon');
    const d0 = await depth0(page);
    assert(d0.folderChev && d0.file && d0.fileIcon, t('depth-0 folder and file rows exist'));
    const filesTagStyle = await page.evaluate(() => {
      const bar = document.querySelector('.files__bar');
      const tag = bar.querySelector('.repo-head__tag--home');
      const b = getComputedStyle(bar);
      const g = getComputedStyle(tag);
      return {
        bar: [b.backgroundColor, b.minHeight, b.borderRadius, b.paddingLeft],
        tag: [g.fontSize, g.fontWeight, g.padding, g.borderRadius],
      };
    });

    await showTab(page, 'Changes');
    await page.waitForSelector('.repo-head .treechev', { timeout: 15000 });
    const headChev = await rect(page, '.repo-head .treechev');
    const headGlyphAll = await rect(page, '.repo-head__glyph');
    assert(
      near(cx(filesChev), cx(headChev)) && near(cx(filesChev), cx(d0.folderChev)),
      t(
        `AC2 chevron centres equal: files ${cx(filesChev)} changes ${cx(headChev)} row ${cx(d0.folderChev)}`,
      ),
    );
    const change = await page.evaluate(() => {
      const row = document.querySelector('.change');
      const r = row.getBoundingClientRect();
      const k = row.querySelector('.change__kind').getBoundingClientRect();
      return {
        left: r.left,
        height: r.height,
        radius: getComputedStyle(row).borderRadius,
        kindLeft: k.left,
      };
    });
    assert(
      near(change.height, 22) && near(d0.file.height, 22),
      t(`AC6 rows 22px: change ${change.height} filerow ${d0.file.height}`),
    );
    assert(change.radius === d0.fileRadius, t(`AC6 radius ${change.radius} vs ${d0.fileRadius}`));
    assert(near(change.left, d0.file.left), t(`AC6 left ${change.left} vs ${d0.file.left}`));
    assert(
      near(change.kindLeft, d0.fileIcon.left),
      t(`AC6 status box ${change.kindLeft} vs file icon ${d0.fileIcon.left}`),
    );
    const headTagStyle = await page.evaluate(() => {
      const head = document.querySelector('.repo-head--home');
      const tag = head.querySelector('.repo-head__tag--home');
      const b = getComputedStyle(head);
      const g = getComputedStyle(tag);
      return {
        bar: [b.backgroundColor, b.minHeight, b.borderRadius, b.paddingLeft],
        tag: [g.fontSize, g.fontWeight, g.padding, g.borderRadius],
      };
    });
    assert(
      JSON.stringify(headTagStyle) === JSON.stringify(filesTagStyle) &&
        filesTagStyle.bar[1] === '32px',
      t(`AC7 header + tag styles equal: ${JSON.stringify([filesTagStyle, headTagStyle])}`),
    );

    // AC3: Active view keeps the glyph column.
    await pickView(page, 'Active repo');
    await page.waitForSelector('.repo-head .treechev-spacer--head', {
      state: 'attached',
      timeout: 8000,
    });
    const headGlyphActive = await rect(page, '.repo-head__glyph');
    await pickView(page, 'All repos');
    await page.waitForSelector('.repo-head__chev', { timeout: 8000 });
    assert(
      near(filesIcon.left, headGlyphAll.left) && near(headGlyphAll.left, headGlyphActive.left),
      t(
        `AC3 glyph x: files ${filesIcon.left} all ${headGlyphAll.left} active ${headGlyphActive.left}`,
      ),
    );

    // AC8 (Changes): collapse ref, Files, back. AC4 reads settled transforms, and a hidden
    // window does not advance CSS transitions, so motion is off while it reads (AC5 covers it).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click(toggleSel('ref', 'Changes'));
    assert((await expanded(page, 'ref')) === 'false', t('AC8 ref collapsed on Changes'));
    await sleep(300);
    // AC4 (Changes)
    const changesChevs = await chevStates(page);
    await showTab(page, 'Files');
    assert((await expanded(page, 'ref')) === 'true', t('D6 Files ref unaffected by Changes'));
    await page.click(toggleSel('ref', 'Files'));
    await sleep(300);
    const filesChevs = await chevStates(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const c of [...changesChevs, ...filesChevs]) {
      assert(near(c.width, 12), t(`AC4 chevron 12px: ${c.width}`));
      assert(
        c.transform === (c.open ? OPEN : 'none'),
        t(`AC4 transform ${c.transform} for open=${c.open} (${c.owner})`),
      );
    }
    assert(
      changesChevs.some((c) => !c.open) && filesChevs.some((c) => !c.open),
      t('AC4 saw a collapsed chevron in each tab'),
    );
    assert(
      (await page.locator('.files__bar-chev, .filerow__chev').count()) === 0,
      t('AC4 no old chevron classes'),
    );
    await showTab(page, 'Changes');
    assert((await expanded(page, 'ref')) === 'false', t('AC8 Changes ref still collapsed'));
    await showTab(page, 'Files');
    assert((await expanded(page, 'ref')) === 'false', t('AC8 Files ref still collapsed'));
    await page.click(toggleSel('ref', 'Files'));

    // AC5
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await page.$eval('.treechev', (c) => getComputedStyle(c).transitionDuration);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await page.$eval('.treechev', (c) => getComputedStyle(c).transitionDuration);
    assert(reduced === '0s' && normal === '0.1s', t(`AC5 durations ${reduced} / ${normal}`));

    // AC9 (Files): name click does not toggle; Enter and Space do.
    for (const tab of ['Files', 'Changes']) {
      await showTab(page, tab);
      const nameSel = tab === 'Files' ? '.files__root-name' : '.repo-head__name';
      const label = 'home';
      const before = await expanded(page, label);
      await page
        .locator(nameSel, { hasText: /^home$/ })
        .first()
        .click();
      assert((await expanded(page, label)) === before, t(`AC9 ${tab} name click does not toggle`));
      await page.focus(toggleSel(label, tab));
      await page.keyboard.press('Enter');
      const afterEnter = await expanded(page, label);
      await page.keyboard.press('Space');
      const afterSpace = await expanded(page, label);
      assert(
        afterEnter !== before && afterSpace === before,
        t(`AC9 ${tab} Enter/Space toggle: ${before} → ${afterEnter} → ${afterSpace}`),
      );
    }

    // AC13
    for (const tab of ['Files', 'Changes']) {
      await showTab(page, tab);
      await page.emulateMedia({ forcedColors: 'active' });
      // Computed `color` is always a system colour under forced colours, so it can't fail; the
      // glyph's own stroke is what goes invisible if it stops following currentColor.
      const paints = await page.$$eval('.treechev', (cs) =>
        cs.map((c) => {
          const path = c.querySelector('path');
          return {
            stroke: path ? getComputedStyle(path).stroke : 'none',
            color: getComputedStyle(c).color,
          };
        }),
      );
      await page.emulateMedia({ forcedColors: 'none' });
      assert(
        paints.length > 0 &&
          paints.every(
            (p) => p.stroke !== 'none' && p.stroke !== 'rgba(0, 0, 0, 0)' && p.stroke === p.color,
          ),
        t(`AC13 ${tab} chevron strokes follow the forced colour: ${JSON.stringify(paints)}`),
      );
    }

    // AC10: a hovered 22px row's actions sit inside it; Stage stages.
    await showTab(page, 'Changes');
    await page.click(toggleSel('ref', 'Changes'));
    assert((await expanded(page, 'ref')) === 'true', t('ref expanded again on Changes'));
    const refUnstaged = page
      .locator('.repo-head[aria-label^="ref,"] + .repo-head__list .change')
      .filter({ has: page.locator('.change__file', { hasText: /^a\.ts$/ }) });
    await refUnstaged.hover();
    await sleep(200);
    const rowBox = await refUnstaged.boundingBox();
    const actBox = await refUnstaged.locator('.change__row-actions').boundingBox();
    assert(
      actBox.y >= rowBox.y - 1 &&
        actBox.y + actBox.height <= rowBox.y + rowBox.height + 1 &&
        actBox.x + actBox.width <= rowBox.x + rowBox.width + 1,
      t(`AC10 row actions inside the row: ${JSON.stringify([rowBox, actBox])}`),
    );
    await refUnstaged.locator('.change__action', { hasText: /^Stage$/ }).click();
    await page.waitForFunction(
      () => {
        const head = [...document.querySelectorAll('.repo-head')].find(
          (h) => h.querySelector('.repo-head__name')?.textContent === 'ref',
        );
        let section = '';
        for (const el of head?.nextElementSibling?.children ?? []) {
          if (el.classList.contains('changes__section')) section = el.textContent ?? '';
          else if (el.querySelector('.change__file')?.textContent === 'a.ts')
            return section.startsWith('Staged');
        }
        return false;
      },
      null,
      { timeout: 15000 },
    );

    // AC12 (geometry) + AC7 narrow tag, on both tabs.
    const origW = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--right-w'),
    );
    for (const w of [280, 200]) {
      for (const tab of ['Files', 'Changes']) {
        await showTab(page, tab);
        const got = await setBarWidth(page, tab === 'Files' && w === 200 ? 196 : w);
        const head = tab === 'Files' ? '.files__bar' : '.repo-head';
        const bad = await chevronClear(page, head);
        assert(
          bad.length === 0,
          t(`AC12 ${tab} @${got}px: chevron overlapped by ${bad.join(', ')}`),
        );
        if (tab === 'Files' && w === 200) {
          const tag = page.locator('.files__bar').first().getByText('Home', { exact: true });
          const box = await tag.boundingBox();
          assert(
            (await tag.count()) >= 1 && box && box.width <= 1 && box.height <= 1,
            t(`AC7 narrow Files tag accessible but clipped: ${JSON.stringify(box)}`),
          );
        }
      }
    }
    await page.evaluate((v) => document.documentElement.style.setProperty('--right-w', v), origW);
    log(`${theme}: AC1–AC10, AC12 geometry, AC13 ✓`);
  } finally {
    await launched.cleanup();
    await removeDir(work);
  }
}

export async function runTreeChevrons(theme) {
  if (process.platform !== 'win32') {
    console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
    await finishScenario(0);
  }
  let code = 0;
  try {
    await runTheme(theme);
    log('PASS ✓');
  } catch (e) {
    if (e?.name === 'AssertionError') {
      log('FAIL ✗', e.message);
      code = 1;
    } else {
      console.error(`[${NAME}] ERROR:`, e?.message || e);
      if (e?.stack) console.error(e.stack);
      code = 2;
    }
  }
  await finishScenario(code);
}

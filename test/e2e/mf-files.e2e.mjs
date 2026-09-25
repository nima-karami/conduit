/**
 * mf-files — the Files tab, search and quick open across a session's folders
 * (docs/specs/archive/2026-09-23-mf-files.md §7.2/§7.3). One phase per plan slice, in order, on one
 * session: home `rmb` (a git repo) + attached `ci-image`, later `api-contracts`.
 *
 * Every button is a real click; pickers answer through `__pickDirHook` (locked L11) and OS
 * drops enter through `window.__conduitOsDrop` (spec §3.3), both e2e-only seams.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

// ── fixture ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'mffiles-e2e-'));
const rmb = join(root, 'rmb');
const ciImage = join(root, 'ci-image');
const apiContracts = join(root, 'api-contracts');
const apiMoved = join(root, 'api-contracts-moved');
const scratch = join(root, 'scratch');

/**
 * Windows refuses to remove a directory while a process has it as its cwd, and the app runs
 * one-shot git commands there (check-ignore per tree read, ls-files for the index) for ~50 ms
 * each. rmSync's maxRetries does not retry that EPERM, so this retries, bounded: a helper that
 * held a folder for longer than one short command would blow the budget.
 */
async function rmFolder(dir, what, budgetMs = 2000) {
  const t0 = Date.now();
  for (let tries = 1; ; tries++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return { ms: Date.now() - t0, tries };
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      assert(
        Date.now() - t0 < budgetMs,
        `${what}: ${dir} still held after ${budgetMs} ms (${tries} tries, ${e.code})`,
      );
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function writeCiImage(dir = ciImage) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const ci = 1;\n');
  writeFileSync(join(dir, 'lib', 'util.ts'), 'export const utilValue = 42;\n');
  writeFileSync(
    join(dir, 'main.ts'),
    "import { utilValue } from './lib/util';\n\nexport const doubled = utilValue * 2;\n",
  );
  writeFileSync(join(dir, 'b.txt'), 'MFTOKEN in ci-image\n');
}

mkdirSync(join(rmb, 'src'), { recursive: true });
writeFileSync(join(rmb, 'src', 'index.ts'), 'export const rmb = 1;\n');
writeFileSync(join(rmb, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
writeFileSync(join(rmb, 'a.txt'), 'MFTOKEN in rmb\n');
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd });
git(rmb, 'init', '-q', '-b', 'main');
git(rmb, 'add', '-A');
git(rmb, 'commit', '-q', '-m', 'init');
writeFileSync(join(rmb, 'src', 'index.ts'), 'export const rmb = 2;\n');
writeCiImage();
mkdirSync(apiContracts, { recursive: true });
writeFileSync(join(apiContracts, 'c.txt'), 'MFTOKEN in api-contracts\n');

// ── page helpers ────────────────────────────────────────────────────────────

const section = (page, label) => page.locator(`.files-section[aria-label="${label}"]`);
const rowIn = (page, label, name) =>
  section(page, label).locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** [name, tag] per section bar, in DOM order. */
const bars = (page) =>
  page.$$eval('.files-section > .files__bar', (els) =>
    els.map((b) => [
      b.querySelector('.files__root-name')?.textContent ?? '',
      b.querySelector('.files__tag')?.textContent ?? '',
    ]),
  );

async function waitBars(page, want, what) {
  const ok = await page
    .waitForFunction(
      (w) => {
        const got = [...document.querySelectorAll('.files-section > .files__bar')].map((b) => [
          b.querySelector('.files__root-name')?.textContent ?? '',
          b.querySelector('.files__tag')?.textContent ?? '',
        ]);
        return JSON.stringify(got) === JSON.stringify(w);
      },
      want,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    ok,
    `${what}: bars should be ${JSON.stringify(want)}, got ${JSON.stringify(await bars(page))}`,
  );
}

const sessionOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id) ?? null, sid);

// ── phases ──────────────────────────────────────────────────────────────────

async function phaseSections({ page, log, sid }) {
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['ci-image', 'Attached'],
    ],
    'AC1/AC2 initial',
  );
  log('two sections, rmb Home then ci-image Attached ✓');

  // QA F1: bar names use the theme's UI face at 600 (9b mock), not the mono header style.
  const face = await page.$eval('.files__root-name', (el) => {
    const cs = getComputedStyle(el);
    const ui = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
    return { family: cs.fontFamily, ui, weight: cs.fontWeight };
  });
  const bare = (f) => f.replace(/["'\s]/g, '');
  assert(
    bare(face.family) === bare(face.ui) && face.weight === '600',
    `F1: bar name should be --font-ui (${face.ui}) 600, got ${face.family} ${face.weight}`,
  );
  log('bar names in --font-ui 600 ✓');

  // D13: a home-repo change at src/index.ts dots rmb's row, never ci-image's same-named one.
  await rowIn(page, 'rmb', 'src').first().click();
  await rowIn(page, 'ci-image', 'src').first().click();
  const rmbIndex = rowIn(page, 'rmb', 'index.ts').first();
  const ciIndex = rowIn(page, 'ci-image', 'index.ts').first();
  await rmbIndex.waitFor({ state: 'attached', timeout: 15000 });
  await ciIndex.waitFor({ state: 'attached', timeout: 15000 });
  await rmbIndex.locator('.filerow__dot').waitFor({ state: 'attached', timeout: 20000 });
  assert(
    (await ciIndex.locator('.filerow__dot').count()) === 0,
    'D13: ci-image/src/index.ts must carry no dot from the rmb repo',
  );
  log('git dot on rmb/src/index.ts only ✓');

  // D3: the chevron collapses the section to its bar.
  await section(page, 'ci-image').locator('button[aria-label="Collapse ci-image"]').click();
  await section(page, 'ci-image')
    .locator('.files-section__tree')
    .waitFor({ state: 'detached', timeout: 5000 });
  assert(
    (await section(page, 'ci-image').locator('.filerow').count()) === 0,
    'a collapsed section shows its bar only',
  );
  await section(page, 'ci-image').locator('button[aria-label="Expand ci-image"]').click();
  await rowIn(page, 'ci-image', 'src').first().waitFor({ state: 'attached', timeout: 5000 });
  assert(
    (await rowIn(page, 'ci-image', 'index.ts').count()) === 0,
    'D3: re-expanding shows the top level only (subfolders were collapsed with the section)',
  );
  log('collapse → bar only; expand → top level ✓');

  // AC8: a terminal cd moves session.cwd but not the Files sections.
  await page.evaluate(
    ({ s, sub }) => {
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: `cd "${sub}"\r` });
    },
    { s: sid, sub: join(rmb, 'src') },
  );
  const moved = await page
    .waitForFunction(
      (id) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return !!s?.cwd && /[\\/]src$/i.test(s.cwd);
      },
      sid,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(
    moved,
    `cd should move session.cwd, got ${JSON.stringify((await sessionOf(page, sid))?.cwd)}`,
  );
  await page.waitForTimeout(500);
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['ci-image', 'Attached'],
    ],
    'AC8 after cd',
  );
  log('cd moved cwd; sections unchanged ✓');
}

const queuePicks = (app, paths) => app.evaluate((_e, p) => global.__pickDirHook.queue(p), paths);

/** The window is hidden, so OS focus never arrives; drive the host's own focus handler. */
const emitFocus = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.emit('focus');
  });

const key = (p) => p.replace(/\\/g, '/').toLowerCase();
const rootsOf = async (page, sid) => ((await sessionOf(page, sid))?.roots ?? []).map(key);

async function folderMenu(page, label) {
  await section(page, label).locator(`button[aria-label="Folder actions for ${label}"]`).click();
  await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 5000 });
  return page.$$eval('.ctxmenu .ctxmenu__item', (els) => els.map((e) => e.textContent?.trim()));
}
async function pickMenu(page, label) {
  await page.locator('.ctxmenu .ctxmenu__item', { hasText: label }).click();
  await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
}

/** Hidden windows throttle rAF; focus moves can land ~1 s late (learnings, mf-new-session). */
async function waitFocusLabel(page, label, what) {
  const ok = await page
    .waitForFunction((l) => document.activeElement?.getAttribute('aria-label') === l, label, {
      timeout: 3000,
    })
    .then(() => true)
    .catch(() => false);
  const got = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  assert(ok, `${what}: focus should be on "${label}", got "${got}"`);
}

async function waitToast(page, text, what) {
  const t = page.locator('.toast', { hasText: text });
  const ok = await t
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const all = await page.$$eval('.toast .toast__msg', (els) => els.map((e) => e.textContent));
  assert(ok, `${what}: a toast "${text}" should show, got ${JSON.stringify(all)}`);
  return t.first();
}

async function phaseActions({ app, page, log, sid }) {
  // Add folder (§2.6): the picker answers api-contracts; it lands last and takes focus.
  await queuePicks(app, [apiContracts]);
  await page.locator('.files__add').click();
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['ci-image', 'Attached'],
      ['api-contracts', 'Attached'],
    ],
    'Add folder',
  );
  await waitFocusLabel(page, 'Collapse api-contracts', 'after Add folder');
  log('Add folder → api-contracts Attached, last, focused ✓');

  await queuePicks(app, [null]);
  await page.locator('.files__add').click();
  await page.waitForTimeout(1200);
  assert((await bars(page)).length === 3, 'a cancelled pick changes nothing');
  log('Add folder cancel → still three ✓');

  // Remove + Undo (AC3).
  await folderMenu(page, 'ci-image');
  await pickMenu(page, 'Remove from session');
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['api-contracts', 'Attached'],
    ],
    'Remove',
  );
  const toast = await waitToast(page, 'Removed ci-image from session', 'Remove');
  await toast.locator('.toast__action', { hasText: 'Undo' }).click();
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['api-contracts', 'Attached'],
      ['ci-image', 'Attached'],
    ],
    'Undo',
  );
  assert((await rootsOf(page, sid)).includes(key(ciImage)), 'Undo re-attaches to this session');
  log('Remove → toast → Undo re-attaches ci-image ✓');

  // D16/AC17: a dirty tab under the folder refuses the remove and posts nothing.
  await rowIn(page, 'ci-image', 'b.txt').first().dblclick();
  await page.waitForSelector('.monaco-editor', { timeout: 15000 });
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.locator('.tab.tab--dirty').first().waitFor({ state: 'attached', timeout: 5000 });
  const rootsBefore = await rootsOf(page, sid);
  await folderMenu(page, 'ci-image');
  await pickMenu(page, 'Remove from session');
  await waitToast(page, 'Save or close 1 unsaved file in ci-image first.', 'dirty refusal');
  await page.waitForTimeout(800);
  assert(
    JSON.stringify(await rootsOf(page, sid)) === JSON.stringify(rootsBefore),
    'dirty refusal leaves roots unchanged',
  );
  assert(
    (await section(page, 'ci-image').count()) === 1,
    'dirty refusal keeps the ci-image section',
  );
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+z');
  await page.locator('.tab.tab--dirty').first().waitFor({ state: 'detached', timeout: 5000 });
  // Close it: the open-file watcher holds its folder open on Windows, and the later phases
  // delete that folder from disk.
  await page.locator('.tab.tab--active .tab__close').click();
  await page.locator('.tab', { hasText: 'b.txt' }).waitFor({ state: 'detached', timeout: 5000 });
  log('Remove refused while ci-image has a dirty tab ✓');

  // Make home (AC5), then restore.
  await folderMenu(page, 'ci-image');
  await pickMenu(page, 'Make home');
  await waitBars(
    page,
    [
      ['ci-image', 'Home'],
      ['api-contracts', 'Attached'],
      ['rmb', 'Attached'],
    ],
    'Make home ci-image',
  );
  await folderMenu(page, 'rmb');
  await pickMenu(page, 'Make home');
  await waitBars(
    page,
    [
      ['rmb', 'Home'],
      ['api-contracts', 'Attached'],
      ['ci-image', 'Attached'],
    ],
    'Make home rmb',
  );
  log('Make home swaps home and appends the old one ✓');

  // AC4: the home bar's menu never offers Remove.
  const homeItems = await folderMenu(page, 'rmb');
  await page.keyboard.press('Escape');
  await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
  assert(
    JSON.stringify(homeItems) === JSON.stringify(['Reveal in Explorer', 'Copy path']),
    `home menu should be Reveal + Copy path only, got ${JSON.stringify(homeItems)}`,
  );
  log('home menu has no Remove / Make home ✓');
}

const missingBox = (page, label) =>
  page.locator(`.files-missing[aria-label="${label}, not found"]`);

async function waitMissing(page, label, what) {
  const box = missingBox(page, label);
  const ok = await box
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(ok, `${what}: ${label} should show the missing box within 10 s`);
  return box;
}

async function phaseMissing({ app, page, log }) {
  await rmFolder(ciImage, 'AC6 setup');
  await emitFocus(app);
  const box = await waitMissing(page, 'ci-image', 'AC6');
  const text = await box.innerText();
  for (const want of ['ci-image', 'Not found', ciImage, 'Locate…', 'Remove']) {
    assert(
      text.includes(want),
      `AC6: missing box should show "${want}", got ${JSON.stringify(text)}`,
    );
  }
  assert((await section(page, 'ci-image').count()) === 0, 'AC6: no bar or tree while missing');
  log('deleted ci-image → warn box (name, Not found, path, Locate…, Remove) ✓');

  writeCiImage();
  const back = await section(page, 'ci-image')
    .locator('.files-section__tree')
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(back, 'AC7: a recreated folder returns to bar + tree within 10 s');
  assert((await missingBox(page, 'ci-image').count()) === 0, 'AC7: the warn box is gone');
  log('recreated ci-image → bar + tree back ✓');
}

async function phaseLocate({ app, page, log, sid }) {
  await rmFolder(apiContracts, 'locate setup');
  await emitFocus(app);
  await waitMissing(page, 'api-contracts', 'locate setup');
  const idx = (await rootsOf(page, sid)).indexOf(key(apiContracts));
  assert(idx >= 0, 'api-contracts is still attached while missing');
  mkdirSync(apiMoved);
  writeFileSync(join(apiMoved, 'c.txt'), 'MFTOKEN in api-contracts\n');
  await queuePicks(app, [apiMoved]);
  await missingBox(page, 'api-contracts').locator('button', { hasText: 'Locate…' }).click();
  const moved = await section(page, 'api-contracts-moved')
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(moved, 'Locate: api-contracts-moved replaces the missing folder');
  const roots = await rootsOf(page, sid);
  assert(
    roots[idx] === key(apiMoved) && !roots.includes(key(apiContracts)),
    `Locate replaces in place (index ${idx}), got ${JSON.stringify(roots)}`,
  );
  const tags = await bars(page);
  assert(
    JSON.stringify(tags.find(([n]) => n === 'api-contracts-moved')) ===
      JSON.stringify(['api-contracts-moved', 'Attached']),
    `api-contracts-moved tagged Attached, got ${JSON.stringify(tags)}`,
  );
  await waitFocusLabel(page, 'Collapse api-contracts-moved', 'after Locate');
  log('Locate… → api-contracts-moved in place, Attached, focused ✓');

  // Right after the Locate, with no settle: nothing may keep the new folder as its cwd.
  const del = await rmFolder(apiMoved, 'delete right after Locate');
  log(`deleted api-contracts-moved right after Locate in ${del.ms} ms (${del.tries} tries) ✓`);

  // AC15: a Locate onto a folder already in the session is refused; the box stays.
  await emitFocus(app);
  await waitMissing(page, 'api-contracts-moved', 'duplicate setup');
  await queuePicks(app, [rmb]);
  await missingBox(page, 'api-contracts-moved').locator('button', { hasText: 'Locate…' }).click();
  const dupToast = await waitToast(page, 'rmb is already in this session.', 'Locate duplicate');
  await menuOverToast(page, dupToast, log);
  assert(
    (await missingBox(page, 'api-contracts-moved').count()) === 1,
    'Locate duplicate: the warn box stays',
  );
  assert(
    JSON.stringify(await rootsOf(page, sid)) === JSON.stringify(roots),
    'Locate duplicate: roots unchanged',
  );
  mkdirSync(apiMoved);
  writeFileSync(join(apiMoved, 'c.txt'), 'MFTOKEN in api-contracts\n');
  const back = await section(page, 'api-contracts-moved')
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(back, 'api-contracts-moved reconnects');
  log('Locate onto rmb → "rmb is already in this session.", box stays ✓');
}

/** Review S2 / QA F3: a folder deleted the moment Add folder lands is not held by the app. */
async function phaseDeleteRightAway({ app, page, log, sid }) {
  mkdirSync(join(scratch, 'src'), { recursive: true });
  writeFileSync(join(scratch, 'src', 'x.ts'), 'export const x = 1;\n');
  git(scratch, 'init', '-q', '-b', 'main');
  const before = await rootsOf(page, sid);
  await queuePicks(app, [scratch]);
  await page.locator('.files__add').click();
  await section(page, 'scratch')
    .locator('.files-section__tree')
    .waitFor({ state: 'visible', timeout: 10000 });
  const del = await rmFolder(scratch, 'delete right after Add folder');
  log(`deleted scratch right after Add folder in ${del.ms} ms (${del.tries} tries) ✓`);
  await emitFocus(app);
  const box = await waitMissing(page, 'scratch', 'deleted scratch');
  await box.locator('button', { hasText: 'Remove' }).click();
  await box.waitFor({ state: 'detached', timeout: 5000 });
  assert(
    JSON.stringify(await rootsOf(page, sid)) === JSON.stringify(before),
    'the deleted scratch folder is removed from the session',
  );
}

const overlap = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x;
  const h = Math.min(a.y + a.height, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x: x + w / 2, y: y + h / 2 } : null;
};

/** QA F2: a menu opened into the toast corner takes the click where it overlaps the toast. */
async function menuOverToast(page, toast, log) {
  const t = await toast.boundingBox();
  assert(t, 'F2: the toast has a box');
  const bar = section(page, 'rmb').locator('.files__bar');
  const item = page.locator('.ctxmenu .ctxmenu__item', { hasText: 'Copy path' });
  // A real right-click can't land on the toast itself, so the bar's handler gets the point.
  const openAt = async (x, y) => {
    await bar.evaluate(
      (el, p) =>
        el.dispatchEvent(
          new MouseEvent('contextmenu', { ...p, button: 2, bubbles: true, cancelable: true }),
        ),
      { clientX: x, clientY: y },
    );
    await item.waitFor({ state: 'visible', timeout: 5000 });
    return item.boundingBox();
  };
  const cx = t.x + t.width / 2;
  const cy = t.y + t.height / 2;
  let i = await openAt(cx, cy);
  let at = overlap(i, t);
  if (!at) {
    await page.keyboard.press('Escape');
    await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
    i = await openAt(cx - (i.x + i.width / 2 - cx), cy - (i.y + i.height / 2 - cy));
    at = overlap(i, t);
  }
  assert(
    at,
    `F2 setup: Copy path ${JSON.stringify(i)} should overlap the toast ${JSON.stringify(t)}`,
  );
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('.ctxmenu__item')?.textContent?.trim() ?? el?.className ?? null;
  }, at);
  assert(
    hit === 'Copy path',
    `F2: the menu must be on top of the toast, hit ${JSON.stringify(hit)}`,
  );
  await page.mouse.click(at.x, at.y);
  await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
  await page
    .locator('[role="status"]', { hasText: 'Copied path' })
    .waitFor({ state: 'attached', timeout: 5000 });
  log('F2: a menu over a toast takes the click at the overlap ✓');
}

const osDrop = (page, items, targetDir) =>
  page.evaluate(({ i, t }) => window.__conduitOsDrop({ items: i, targetDir: t, x: 200, y: 200 }), {
    i: items,
    t: targetDir,
  });

async function phaseDrop({ page, log, sid }) {
  assert(
    await page.evaluate(() => typeof window.__conduitOsDrop === 'function'),
    'AC18: window.__conduitOsDrop is installed under CONDUIT_E2E=1',
  );
  const ext = join(root, 'ext-folder');
  mkdirSync(ext);
  writeFileSync(join(ext, 'e.txt'), 'external\n');
  // For the goto phase: a global only a whole-folder index can see (nothing imports it).
  writeFileSync(join(ext, 'globals.d.ts'), 'declare const extGlobal: number;\n');
  writeFileSync(join(ext, 'use.ts'), 'export const v = extGlobal;\n');

  // AC9: an eligible folder opens the drop-intent menu with Attach focused.
  await osDrop(page, [{ path: ext, isDir: true }], rmb);
  await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 5000 });
  const items = await page.$$eval('.ctxmenu .ctxmenu__item', (els) =>
    els.map((e) => e.textContent?.trim()),
  );
  assert(
    JSON.stringify(items) === JSON.stringify(['Attach to session', 'Copy into rmb/', 'Cancel']),
    `AC9: drop menu items, got ${JSON.stringify(items)}`,
  );
  // ContextMenu focuses by aria-activedescendant (the keyboard highlight Enter acts on).
  const focused = await page
    .waitForFunction(
      () => {
        const menu = document.querySelector('.ctxmenu[role="menu"]');
        const id = menu?.getAttribute('aria-activedescendant');
        const active = id ? document.getElementById(id) : null;
        return (
          active?.textContent?.trim() === 'Attach to session' &&
          active.classList.contains('ctxmenu__item--active') &&
          document.querySelectorAll('.ctxmenu__item--active').length === 1
        );
      },
      null,
      { timeout: 3000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(focused, 'AC9: Attach to session is the focused (active) item');
  await page.keyboard.press('Enter');
  const bar = await section(page, 'ext-folder')
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(bar, 'Enter attaches ext-folder');
  const names = (await bars(page)).map(([n]) => n);
  assert(names[names.length - 1] === 'ext-folder', `ext-folder is last, got ${names}`);
  assert(!existsSync(join(rmb, 'ext-folder')), 'attaching copies nothing into rmb');
  log('folder drop → menu (Attach focused) → Enter attaches, nothing copied ✓');

  // AC10: a file-only drop imports as today — no menu.
  const extFile = join(root, 'ext.txt');
  writeFileSync(extFile, 'a file\n');
  await osDrop(page, [{ path: extFile, isDir: false }], rmb);
  const menu = await page
    .locator('.ctxmenu')
    .waitFor({ state: 'visible', timeout: 500 })
    .then(() => true)
    .catch(() => false);
  assert(!menu, 'AC10: a file-only drop opens no menu');
  for (let i = 0; i < 40 && !existsSync(join(rmb, 'ext.txt')); i++) await page.waitForTimeout(100);
  assert(existsSync(join(rmb, 'ext.txt')), 'AC10: the file is copied into rmb');
  log('file drop → no menu, copied ✓');

  // Esc cancels: nothing attached, nothing copied.
  const ext2 = join(root, 'ext-two');
  mkdirSync(ext2);
  const rootsBefore = await rootsOf(page, sid);
  await osDrop(page, [{ path: ext2, isDir: true }], rmb);
  await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(800);
  assert(
    JSON.stringify(await rootsOf(page, sid)) === JSON.stringify(rootsBefore),
    'Esc attaches nothing',
  );
  assert(!existsSync(join(rmb, 'ext-two')), 'Esc copies nothing');
  // The guard cleared with the menu: the next drop opens it again.
  await osDrop(page, [{ path: ext2, isDir: true }], rmb);
  await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
  log('Esc → nothing attached or copied; the next drop is accepted again ✓');
}

async function phaseSearch({ page, log }) {
  const input = page.locator('.search__inputbox textarea');
  await input.click();
  await input.fill('MFTOKEN');
  const grouped = await page
    .waitForFunction(
      () => {
        const heads = [...document.querySelectorAll('.searchfolder .searchfolder__name')].map(
          (h) => h.textContent,
        );
        return heads.length === 3 ? heads : null;
      },
      null,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  assert(
    JSON.stringify(grouped) === JSON.stringify(['rmb', 'api-contracts-moved', 'ci-image']),
    `AC11: three folder groups in folder order, got ${JSON.stringify(grouped)}`,
  );
  const summary = (await page.locator('.search__summary').innerText()).trim();
  assert(summary.endsWith('· 3 folders'), `AC11: summary ends "· 3 folders", got "${summary}"`);
  log(`search grouped by folder (${summary}) ✓`);

  await page
    .locator('.searchfolder', {
      has: page.locator('.searchfolder__name', { hasText: /^api-contracts-moved$/ }),
    })
    .locator('.searchmatch')
    .first()
    .click();
  await page
    .locator('.tabbar [role="tab"].tab--active', { hasText: 'c.txt' })
    .waitFor({ state: 'visible', timeout: 10000 });
  log('a match in the api-contracts-moved group opens c.txt ✓');
  await input.fill('');
}

/** Files-group palette rows as [title, badge text | null, badge title | null]. */
const paletteFileRows = (page) =>
  page.evaluate(() => {
    const group = [...document.querySelectorAll('.palette__group')].find(
      (g) => g.querySelector('.palette__gtitle')?.textContent === 'Files',
    );
    return [...(group?.querySelectorAll('.palette__row') ?? [])].map((r) => {
      const b = r.querySelector('.palette__badge');
      return [
        r.querySelector('.palette__title')?.textContent ?? '',
        b?.textContent ?? null,
        b?.getAttribute('title') ?? null,
      ];
    });
  });

async function openPalette(page, query) {
  // From the page, not a field: the search box keeps its own keys.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill(query);
}

async function phaseQuickOpen({ page, log }) {
  await openPalette(page, 'util');
  const rows = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.palette__row .palette__title')].some(
          (t) => t.textContent === 'lib/util.ts',
        ),
      null,
      { timeout: 15000 },
    )
    .then(() => paletteFileRows(page))
    .catch(() => paletteFileRows(page));
  assert(rows.length > 0, `quick open lists Files rows for "util", got ${JSON.stringify(rows)}`);
  assert(
    rows.every(([, badge]) => badge !== null),
    `AC12: every Files row carries a folder tag, got ${JSON.stringify(rows)}`,
  );
  const util = rows.find(([t]) => t === 'lib/util.ts');
  assert(
    util?.[1] === 'ci-image' && key(util?.[2] ?? '') === key(ciImage),
    `AC12: lib/util.ts tagged ci-image with its folder path as title, got ${JSON.stringify(util)}`,
  );
  await page.keyboard.press('Escape');
  await page.locator('.palette__input').waitFor({ state: 'detached', timeout: 5000 });
  log('quick open: every file row tagged; lib/util.ts → ci-image ✓');
}

/** Caret on `token` (line `line`) in the open file ending `from`; Go to Definition until an
 *  editor on a model ending `to` exists. Returns that model path, or null. */
async function gotoLands(page, { from, line, token, to }) {
  const placed = await page
    .waitForFunction(
      ({ from, line, token }) => {
        const ed = window.monaco?.editor
          .getEditors()
          .find((e) => e.getModel()?.uri.path.endsWith(from));
        if (!ed) return false;
        const col = ed.getModel().getLineContent(line).indexOf(token);
        if (col < 0) return false;
        ed.setPosition({ lineNumber: line, column: col + 2 });
        ed.focus();
        return true;
      },
      { from, line, token },
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(placed, `the caret could not be placed on ${token} in ${from}`);
  // Retried from Node: the worker may still be building its program on the first attempt.
  let landed = null;
  for (let attempt = 0; attempt < 10 && !landed; attempt++) {
    landed = await page.evaluate(
      async ({ from, to }) => {
        const ed = window.monaco.editor
          .getEditors()
          .find((e) => e.getModel()?.uri.path.endsWith(from));
        if (ed) await ed.getAction('conduit.goToDefinition')?.run();
        await new Promise((r) => setTimeout(r, 1500));
        return (
          window.monaco.editor
            .getEditors()
            .map((e) => e.getModel()?.uri.path ?? '')
            .find((p) => p.endsWith(to)) ?? null
        );
      },
      { from, to },
    );
  }
  return landed;
}

async function phaseGoto({ page, log }) {
  await rowIn(page, 'ci-image', 'main.ts').first().dblclick();
  const viaImport = await gotoLands(page, {
    from: 'ci-image/main.ts',
    line: 3,
    token: 'utilValue',
    to: 'ci-image/lib/util.ts',
  });
  assert(typeof viaImport === 'string', 'Go to Definition in ci-image lands in lib/util.ts');
  log(`go to definition (import) → ${viaImport} ✓`);

  // Discriminating: a global declared in a file nothing imports is only in the program when the
  // whole attached folder was indexed; an import-following seed wave cannot reach it.
  await rowIn(page, 'ext-folder', 'use.ts').first().dblclick();
  const viaIndex = await gotoLands(page, {
    from: 'ext-folder/use.ts',
    line: 1,
    token: 'extGlobal',
    to: 'ext-folder/globals.d.ts',
  });
  assert(
    typeof viaIndex === 'string',
    'Go to Definition reaches an un-imported declaration in ext-folder (the attached folder is indexed)',
  );
  log(`go to definition (folder index) → ${viaIndex} ✓`);
}

const hasBinary = (name) => spawnSync('where', [name], { stdio: 'ignore' }).status === 0;
const goplsInstalled = () =>
  hasBinary('gopls') || existsSync(join(homedir(), 'go', 'bin', 'gopls.exe'));

async function phaseTrust({ page, log }) {
  if (!hasBinary('go') || !goplsInstalled()) {
    log('SKIP trust (no go toolchain)');
    return;
  }
  writeFileSync(join(ciImage, 'go.mod'), 'module example.com/ci\n\ngo 1.21\n');
  writeFileSync(join(ciImage, 'main.go'), 'package main\n\nfunc main() {}\n');
  await section(page, 'ci-image').locator('button[aria-label="Refresh ci-image"]').click();
  await rowIn(page, 'ci-image', 'main.go').first().waitFor({ state: 'attached', timeout: 10000 });
  await rowIn(page, 'ci-image', 'main.go').first().dblclick();
  const prompt = page.locator('.trust-prompt');
  await prompt.waitFor({ state: 'visible', timeout: 20000 });
  const folder = (await prompt.locator('.trust-prompt__folder').textContent()) ?? '';
  assert(
    key(folder.trim()) === key(ciImage),
    `the trust prompt names the attached folder ${ciImage}, got "${folder}"`,
  );
  log(`trust prompt names ci-image (${folder.trim()}) ✓`);
}

async function phaseQuickOpenSingle({ page, log }) {
  const solo = join(root, 'solo');
  mkdirSync(solo);
  writeFileSync(join(solo, 'solo-util.ts'), 'export const s = 1;\n');
  await openSession(page, { path: solo });
  await openPalette(page, 'solo-util');
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.palette__row .palette__title')].some(
          (t) => t.textContent === 'solo-util.ts',
        ),
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  const rows = await paletteFileRows(page);
  assert(
    rows.some(([t]) => t === 'solo-util.ts'),
    `the solo session's file is listed, got ${JSON.stringify(rows)}`,
  );
  assert(
    rows.every(([, badge]) => badge === null),
    `AC12: a home-only session's Files rows carry no tag, got ${JSON.stringify(rows)}`,
  );
  await page.keyboard.press('Escape');
  log('quick open in a home-only session: no folder tags ✓');
}

runScenario('mf-files', async ({ app, page, log }) => {
  const sid = await openSession(page, {
    path: rmb,
    roots: [ciImage],
    agentId: 'shell:powershell',
  });
  log('session', sid);
  const ctx = { app, page, log, sid };
  await phaseSections(ctx);
  await phaseActions(ctx);
  await phaseMissing(ctx);
  await phaseLocate(ctx);
  await phaseDeleteRightAway(ctx);
  await phaseDrop(ctx);
  await phaseSearch(ctx);
  await phaseQuickOpen(ctx);
  await phaseGoto(ctx);
  await phaseTrust(ctx);
  await phaseQuickOpenSingle(ctx);
});

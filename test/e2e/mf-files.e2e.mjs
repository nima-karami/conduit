/**
 * mf-files — the Files tab, search and quick open across a session's folders
 * (docs/specs/2026-09-23-mf-files.md §7.2/§7.3). One phase per plan slice, in order, on one
 * session: home `rmb` (a git repo) + attached `ci-image`, later `api-contracts`.
 *
 * Every button is a real click; pickers answer through `__pickDirHook` (locked L11) and OS
 * drops enter through `window.__conduitOsDrop` (spec §3.3), both e2e-only seams.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

// ── fixture ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'mffiles-e2e-'));
const rmb = join(root, 'rmb');
const ciImage = join(root, 'ci-image');
const apiContracts = join(root, 'api-contracts');
const ciImageMoved = join(root, 'ci-image-moved');
// The app's watcher briefly holds a watched folder open on Windows, so a delete can EPERM.
const RM = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

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
  rmSync(ciImage, RM);
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
  rmSync(ciImage, RM);
  await emitFocus(app);
  await waitMissing(page, 'ci-image', 'locate setup');
  const idx = (await rootsOf(page, sid)).indexOf(key(ciImage));
  assert(idx >= 0, 'ci-image is still attached while missing');
  writeCiImage(ciImageMoved);
  await queuePicks(app, [ciImageMoved]);
  await missingBox(page, 'ci-image').locator('button', { hasText: 'Locate…' }).click();
  const moved = await section(page, 'ci-image-moved')
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(moved, 'Locate: ci-image-moved replaces the missing folder');
  const roots = await rootsOf(page, sid);
  assert(
    roots[idx] === key(ciImageMoved) && !roots.includes(key(ciImage)),
    `Locate replaces in place (index ${idx}), got ${JSON.stringify(roots)}`,
  );
  const tags = await bars(page);
  assert(
    JSON.stringify(tags.find(([n]) => n === 'ci-image-moved')) ===
      JSON.stringify(['ci-image-moved', 'Attached']),
    `ci-image-moved tagged Attached, got ${JSON.stringify(tags)}`,
  );
  await waitFocusLabel(page, 'Collapse ci-image-moved', 'after Locate');
  log('Locate… → ci-image-moved in place, Attached, focused ✓');

  // AC15: a Locate onto a folder already in the session is refused; the box stays.
  rmSync(apiContracts, RM);
  await emitFocus(app);
  await waitMissing(page, 'api-contracts', 'duplicate setup');
  await queuePicks(app, [rmb]);
  await missingBox(page, 'api-contracts').locator('button', { hasText: 'Locate…' }).click();
  await waitToast(page, 'rmb is already in this session.', 'Locate duplicate');
  assert(
    (await missingBox(page, 'api-contracts').count()) === 1,
    'Locate duplicate: the warn box stays',
  );
  mkdirSync(apiContracts, { recursive: true });
  writeFileSync(join(apiContracts, 'c.txt'), 'MFTOKEN in api-contracts\n');
  await section(page, 'api-contracts')
    .waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => {});
  assert((await section(page, 'api-contracts').count()) === 1, 'api-contracts reconnects');
  log('Locate onto rmb → "rmb is already in this session.", box stays ✓');
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
});

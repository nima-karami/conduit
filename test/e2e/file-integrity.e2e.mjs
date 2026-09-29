/**
 * File integrity against the real built app: an Explorer rename (F2) of an open, dirty file or of
 * the folder holding one retargets the tab — buffer, dirty state, cursor and the auto-save writer
 * all follow the new path, and nothing is ever written back to the old one. And a > 2 MB file,
 * which the host only loads the head of, can never be written over the full file by Ctrl+S,
 * Save All, close→Save or auto save. Deleting an open file from Files closes its tab.
 *
 * Run after a fresh build: `npm run build` then `node test/e2e/run-smoke.mjs file-integrity`.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeTab,
  disk,
  isDirty,
  openFile,
  paletteSaveAll,
  runAutoSave,
  setMode,
  sleep,
  tab,
  waitFor,
  writesTo,
} from './auto-save-helpers.mjs';
import { assert } from './harness.mjs';

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (page, name) =>
  page
    .locator('.filerow', {
      has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
    })
    .first();

/** Model URIs, normalised to forward slashes and a lowercase drive so they can be matched. */
const modelUris = (page) =>
  page.evaluate(() =>
    window.monaco.editor.getModels().map((m) => decodeURIComponent(m.uri.toString()).toLowerCase()),
  );
const modelValueAt = (page, tail) =>
  page.evaluate(
    (t) =>
      window.monaco.editor
        .getModels()
        .find((m) => decodeURIComponent(m.uri.toString()).toLowerCase().endsWith(t))
        ?.getValue() ?? null,
    tail,
  );
const cursorIn = (page, tail) =>
  page.evaluate((t) => {
    const ed = window.monaco.editor.getEditors().find((e) =>
      decodeURIComponent(e.getModel()?.uri.toString() ?? '')
        .toLowerCase()
        .endsWith(t),
    );
    const p = ed?.getPosition();
    return p ? { line: p.lineNumber, column: p.column } : null;
  }, tail);

/** A real F2 on the row: focus it with a click, press F2, type the new name, commit with Enter. */
async function renameRow(page, from, to) {
  await row(page, from).click();
  await page.keyboard.press('F2');
  const input = page.locator('.filerow__input').first();
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill(to);
  await input.press('Enter');
  await input.waitFor({ state: 'detached', timeout: 5000 });
}

async function editAt(page, line, column, text) {
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.evaluate(
    ({ l, c }) => {
      const ed = window.monaco.editor.getEditors().find((e) => e.hasTextFocus());
      ed.setPosition({ lineNumber: l, column: c });
    },
    { l: line, c: column },
  );
  await page.keyboard.type(text);
}

async function phaseFileRename({ app, page, root, log, shot }) {
  await setMode(page, 'off');
  await openFile(page, 'a.ts');
  await editAt(page, 2, 1, 'X');
  await waitFor(() => isDirty(page, 'a.ts'), 'a.ts dirty');
  const before = await cursorIn(page, '/a.ts');

  await renameRow(page, 'a.ts', 'b.ts');
  await waitFor(() => existsSync(join(root, 'b.ts')), 'the rename on disk');
  assert(!existsSync(join(root, 'a.ts')), 'a.ts is gone on disk');
  await waitFor(async () => (await tab(page, 'b.ts').count()) === 1, 'the tab to become b.ts');
  assert((await tab(page, 'a.ts').count()) === 0, 'no tab is left on the old a.ts');
  assert(await isDirty(page, 'b.ts'), 'the retargeted tab keeps its dirty state');
  assert(
    (await modelValueAt(page, '/b.ts')) === 'one\nXtwo\nthree\n',
    'the retargeted tab keeps the unsaved buffer',
  );
  assert(
    !(await modelUris(page)).some((u) => u.endsWith('/a.ts')),
    'no model is left on the old path',
  );
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 10000 });
  const after = await cursorIn(page, '/b.ts');
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    `the cursor survives the rename (${JSON.stringify(before)} → ${JSON.stringify(after)})`,
  );
  await shot('rename-file-retargeted');
  log('file rename: the tab, buffer, dirty dot and cursor follow a.ts → b.ts ✓');

  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+S');
  await waitFor(() => disk(root, 'b.ts') === 'one\nXtwo\nthree\n', 'Ctrl+S to write b.ts');
  await waitFor(async () => !(await isDirty(page, 'b.ts')), 'the dot to clear');
  await sleep(300);
  assert(!existsSync(join(root, 'a.ts')), 'saving never recreates the old a.ts');
  assert((await writesTo(app, 'a.ts')).length === 0, 'no write ever targeted a.ts');
  log('file rename: Ctrl+S writes b.ts and never recreates a.ts ✓');
  await closeTab(page, 'b.ts');
}

async function phaseFolderRename({ app, page, root, log, shot }) {
  await setMode(page, 'off');
  await row(page, 'dir').click();
  await openFile(page, 'c.ts');
  await editAt(page, 1, 1, 'Y');
  await waitFor(() => isDirty(page, 'c.ts'), 'c.ts dirty');

  await renameRow(page, 'dir', 'dir2');
  await waitFor(() => existsSync(join(root, 'dir2', 'c.ts')), 'the folder rename on disk');
  await waitFor(
    async () => (await modelUris(page)).some((u) => u.endsWith('/dir2/c.ts')),
    'the tab to retarget under dir2',
  );
  assert(
    !(await modelUris(page)).some((u) => u.endsWith('/dir/c.ts')),
    'no model is left under the old folder',
  );
  assert((await tab(page, 'c.ts').count()) === 1, 'still exactly one c.ts tab');
  assert(await isDirty(page, 'c.ts'), 'the retargeted tab keeps its dirty state');
  assert((await modelValueAt(page, '/dir2/c.ts')) === 'Yone\n', 'the unsaved buffer survives');
  await shot('rename-folder-retargeted');
  log('folder rename: the open c.ts retargets to dir2 with its buffer ✓');

  // The per-path auto-save writer moved with it: an automatic save lands on the new path.
  await setMode(page, 'afterDelay', 200);
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 10000 });
  await editAt(page, 1, 1, 'Z');
  await waitFor(() => disk(root, 'dir2/c.ts') === 'ZYone\n', 'auto save to write dir2/c.ts');
  await sleep(500);
  assert(!existsSync(join(root, 'dir')), 'the old folder is never recreated');
  const orphan = (await app.evaluate(() => global.__writeSpy)).filter((w) =>
    w.path.replace(/\\/g, '/').endsWith('/dir/c.ts'),
  );
  assert(orphan.length === 0, `no write targeted dir/c.ts (${orphan.length})`);
  log('folder rename: auto save writes dir2/c.ts, never the old path ✓');
  await setMode(page, 'off');
  await closeTab(page, 'c.ts');
}

async function phaseDeleteOpen({ page, root, log }) {
  await openFile(page, 'gone.ts');
  await row(page, 'gone.ts').click();
  await page.keyboard.press('Delete');
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 8000 });
  await page.locator('.confirm .btn--danger').click();
  await waitFor(() => !existsSync(join(root, 'gone.ts')), 'the delete on disk', 10000);
  await waitFor(async () => (await tab(page, 'gone.ts').count()) === 0, 'the deleted tab to close');
  log('delete: deleting an open file from Files closes its tab ✓');
}

const BIG_LINE = `${'x'.repeat(99)}\n`;
const BIG = BIG_LINE.repeat(25_000); // 2.5 MB — over the host's 2 MB read cap

/** Make the buffer dirty without the editor — the way a cross-file refactor edits a model. */
const dirtyBigModel = (page) =>
  page.evaluate(() => {
    const m = window.monaco.editor
      .getModels()
      .find((x) => decodeURIComponent(x.uri.toString()).toLowerCase().endsWith('/big.txt'));
    m.applyEdits([{ range: new window.monaco.Range(1, 1, 1, 1), text: 'EDIT' }]);
  });

async function phaseTruncated({ app, page, root, log, shot }) {
  const size = () => statSync(join(root, 'big.txt')).size;
  const full = BIG.length;
  await setMode(page, 'off');
  await openFile(page, 'big.txt');
  const banner = await page.locator('.viewer__banner').first().textContent();
  log(`banner: ${JSON.stringify(banner)}`);
  await shot('truncated-open');

  // Typing into the editor must not produce a writable buffer.
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('typed');
  await sleep(200);
  await page.keyboard.press('Control+S');
  await sleep(800);
  assert(size() === full, `Ctrl+S after typing kept the file whole (${size()} of ${full})`);

  await dirtyBigModel(page);
  await waitFor(() => isDirty(page, 'big.txt'), 'the model edit to mark big.txt dirty');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+S');
  await sleep(800);
  assert(size() === full, `Ctrl+S kept the file whole (${size()} of ${full})`);
  await shot('truncated-ctrl-s');
  log('truncated: Ctrl+S cannot truncate ✓');

  await paletteSaveAll(page);
  await sleep(800);
  assert(size() === full, `Save All kept the file whole (${size()} of ${full})`);
  log('truncated: Save All cannot truncate ✓');

  await setMode(page, 'afterDelay', 200);
  await dirtyBigModel(page);
  await sleep(1200);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(800);
  assert(size() === full, `auto save kept the file whole (${size()} of ${full})`);
  log('truncated: auto save cannot truncate ✓');
  await setMode(page, 'off');

  await closeTab(page, 'big.txt', 'Save');
  await sleep(800);
  assert(size() === full, `close→Save kept the file whole (${size()} of ${full})`);
  log('truncated: close→Save cannot truncate ✓');
  assert((await writesTo(app, 'big.txt')).length === 0, 'no write ever reached the host');
  if ((await tab(page, 'big.txt').count()) > 0) await closeTab(page, 'big.txt', 'Discard');
}

runAutoSave('file-integrity', {
  files: {
    'a.ts': 'one\ntwo\nthree\n',
    'dir/c.ts': 'one\n',
    'gone.ts': 'one\n',
    'big.txt': BIG,
  },
  phases: {
    fileRename: phaseFileRename,
    folderRename: phaseFolderRename,
    deleteOpen: phaseDeleteOpen,
    truncated: phaseTruncated,
  },
});

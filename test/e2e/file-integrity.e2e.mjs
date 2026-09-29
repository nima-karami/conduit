/**
 * File integrity against the real built app: an Explorer rename (F2) of an open, dirty file or of
 * the folder holding one retargets the tab — buffer, dirty state, cursor and the auto-save writer
 * all follow the new path, and nothing is ever written back to the old one. And a > 2 MB file,
 * which the host only loads the head of, can never be written over the full file by Ctrl+S,
 * Save All, close→Save or auto save. Undo of a rename and a drag-move retarget the same way, and
 * a renamed path leaves the TS project. Deleting a file or folder closes its clean tabs; a dirty
 * one stays open, marked deleted, and nothing recreates it until the user picks Overwrite.
 *
 * Run after a fresh build: `npm run build` then `node test/e2e/run-smoke.mjs file-integrity`.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  activate,
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

async function deleteRow(page, name) {
  await row(page, name).click();
  await page.keyboard.press('Delete');
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 8000 });
  await page.locator('.confirm .btn--danger').click();
}

const deletedBanner = (page) =>
  page.locator('.viewer__banner--warn', { hasText: 'was deleted on disk' });

async function overwrite(page) {
  await deletedBanner(page).locator('button', { hasText: 'Overwrite' }).click();
}

async function phaseFolderDelete({ page, root, log, shot }) {
  await setMode(page, 'off');
  await row(page, 'fdel').click();
  await openFile(page, 'x.ts');
  await openFile(page, 'y.ts');
  await editAt(page, 1, 1, 'Y');
  await waitFor(() => isDirty(page, 'y.ts'), 'y.ts dirty');

  await deleteRow(page, 'fdel');
  await waitFor(() => !existsSync(join(root, 'fdel')), 'the folder delete on disk', 10000);
  await waitFor(async () => (await tab(page, 'x.ts').count()) === 0, 'the clean tab to close');
  assert((await tab(page, 'y.ts').count()) === 1, 'the dirty tab inside the folder stays open');
  await activate(page, 'y.ts');
  await deletedBanner(page).waitFor({ timeout: 5000 });
  assert((await modelValueAt(page, '/fdel/y.ts')) === 'Yone\n', 'its buffer is kept');
  await shot('folder-delete-dirty-kept');
  log('folder delete: the clean tab closes, the dirty one stays marked deleted ✓');

  await overwrite(page);
  await waitFor(
    () => existsSync(join(root, 'fdel', 'y.ts')) && disk(root, 'fdel/y.ts') === 'Yone\n',
    'Overwrite to recreate fdel/y.ts',
  );
  await waitFor(async () => !(await isDirty(page, 'y.ts')), 'the dot to clear');
  log('folder delete: Overwrite recreates the file and its folder ✓');
  await closeTab(page, 'y.ts');
}

async function phaseDirtyDelete({ app, page, root, log }) {
  await setMode(page, 'off');
  await openFile(page, 'dd.ts');
  await editAt(page, 1, 1, 'D');
  await waitFor(() => isDirty(page, 'dd.ts'), 'dd.ts dirty');
  await deleteRow(page, 'dd.ts');
  await waitFor(() => !existsSync(join(root, 'dd.ts')), 'the delete on disk', 10000);
  await deletedBanner(page).waitFor({ timeout: 5000 });
  assert((await tab(page, 'dd.ts').count()) === 1, 'the dirty tab stays open');
  assert(await isDirty(page, 'dd.ts'), 'and keeps its unsaved state');

  await setMode(page, 'afterDelay', 200);
  await editAt(page, 1, 1, 'E');
  await sleep(1000);
  await page.keyboard.press('Control+S');
  await sleep(800);
  assert(!existsSync(join(root, 'dd.ts')), 'neither auto save nor Ctrl+S recreates it silently');
  assert((await writesTo(app, 'dd.ts')).length === 0, 'no write targeted dd.ts');
  log('dirty delete: the tab stays, marked deleted; nothing recreates the file ✓');

  await overwrite(page);
  await waitFor(
    () => existsSync(join(root, 'dd.ts')) && disk(root, 'dd.ts') === 'EDone\n',
    'Overwrite to recreate dd.ts',
  );
  log('dirty delete: Overwrite recreates it with the buffer ✓');
  await setMode(page, 'off');
  await closeTab(page, 'dd.ts');
}

async function phaseUndoRename({ app, page, root, log }) {
  await setMode(page, 'off');
  await openFile(page, 'u.ts');
  await editAt(page, 1, 1, 'U');
  await waitFor(() => isDirty(page, 'u.ts'), 'u.ts dirty');
  await renameRow(page, 'u.ts', 'u2.ts');
  await waitFor(
    async () => (await tab(page, 'u2.ts').count()) === 1,
    'the tab to follow the rename',
  );

  // Explorer undo (Mod+Z) needs focus outside the editor.
  await row(page, 'u2.ts').click();
  await page.keyboard.press('Control+Z');
  await waitFor(() => existsSync(join(root, 'u.ts')), 'the undo on disk', 10000);
  await waitFor(async () => (await tab(page, 'u.ts').count()) === 1, 'the tab to follow the undo');
  assert((await tab(page, 'u2.ts').count()) === 0, 'no tab is left on u2.ts');
  assert(await isDirty(page, 'u.ts'), 'the tab is still dirty');
  assert((await modelValueAt(page, '/u.ts')) === 'Uone\n', 'with its buffer');
  await activate(page, 'u.ts');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+S');
  await waitFor(() => disk(root, 'u.ts') === 'Uone\n', 'Ctrl+S to write u.ts');
  assert(!existsSync(join(root, 'u2.ts')), 'u2.ts is never recreated');
  assert((await writesTo(app, 'u2.ts')).length === 0, 'no write targeted u2.ts');
  log('undo rename: the tab follows the file back with its buffer ✓');
  await closeTab(page, 'u.ts');
}

async function phaseDragMove({ app, page, root, log }) {
  await setMode(page, 'off');
  await openFile(page, 'm.ts');
  await editAt(page, 1, 1, 'M');
  await waitFor(() => isDirty(page, 'm.ts'), 'm.ts dirty');
  await row(page, 'm.ts').dragTo(row(page, 'mdir'));
  await waitFor(() => existsSync(join(root, 'mdir', 'm.ts')), 'the move on disk', 10000);
  await waitFor(
    async () => (await modelUris(page)).some((u) => u.endsWith('/mdir/m.ts')),
    'the tab to follow the move',
  );
  assert(await isDirty(page, 'm.ts'), 'the moved tab is still dirty');
  assert((await modelValueAt(page, '/mdir/m.ts')) === 'Mone\n', 'with its buffer');
  await activate(page, 'm.ts');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+S');
  await waitFor(() => disk(root, 'mdir/m.ts') === 'Mone\n', 'Ctrl+S to write mdir/m.ts');
  assert(!existsSync(join(root, 'm.ts')), 'the old m.ts is never recreated');
  const old = (await app.evaluate(() => global.__writeSpy)).filter(
    (w) =>
      w.path.replace(/\\/g, '/').toLowerCase() ===
      join(root, 'm.ts').replace(/\\/g, '/').toLowerCase(),
  );
  assert(old.length === 0, `no write targeted the old m.ts (${old.length})`);
  log('drag move: the tab follows the file with its buffer ✓');
  await closeTab(page, 'm.ts');
}

/** A move that REPLACES a file open in another tab: that tab goes, the moved one takes its path. */
async function phaseDragReplace({ page, root, log }) {
  await setMode(page, 'off');
  await row(page, 'rdir').click();
  const rRows = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^r\.ts$/ }),
  });
  await rRows.nth(1).waitFor({ state: 'attached', timeout: 10000 });
  await rRows.nth(0).dblclick(); // rdir/r.ts — the tree lists the folder's child first
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
  await rRows.nth(1).dblclick(); // r.ts at the root
  await waitFor(async () => (await tab(page, 'r.ts').count()) === 1, 'the r.ts tabs');
  await waitFor(
    async () => (await page.locator('.tabbar [role="tab"]', { hasText: 'r.ts' }).count()) === 2,
    'two r.ts tabs',
  );
  await waitFor(
    async () => (await modelUris(page)).filter((u) => u.endsWith('/r.ts')).length === 2,
    'both r.ts models',
  );
  const rootModel = (await modelUris(page)).find(
    (u) => u.endsWith('/r.ts') && !u.includes('/rdir/'),
  );
  await page.evaluate((u) => {
    const m = window.monaco.editor
      .getModels()
      .find((x) => decodeURIComponent(x.uri.toString()).toLowerCase() === u);
    m.applyEdits([{ range: new window.monaco.Range(1, 1, 1, 1), text: 'R' }]);
  }, rootModel);

  await rRows.nth(1).dragTo(row(page, 'rdir'));
  await page.waitForSelector('.confirm .btn--danger', { state: 'visible', timeout: 8000 });
  await page.locator('.confirm .btn--danger', { hasText: 'Replace' }).click();
  await waitFor(() => !existsSync(join(root, 'r.ts')), 'the move on disk', 10000);
  await waitFor(
    async () => (await page.locator('.tabbar [role="tab"]', { hasText: 'r.ts' }).count()) === 1,
    'one r.ts tab left',
  );
  const uris = (await modelUris(page)).filter((u) => u.endsWith('/r.ts'));
  assert(
    uris.length === 1 && uris[0].includes('/rdir/'),
    `only the moved buffer is left, at rdir/r.ts (${uris})`,
  );
  assert((await modelValueAt(page, '/rdir/r.ts')) === 'Rsrc\n', 'it holds the moved buffer');
  assert(await isDirty(page, 'r.ts'), 'and is still dirty');
  await activate(page, 'r.ts');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+S');
  await waitFor(() => disk(root, 'rdir/r.ts') === 'Rsrc\n', 'Ctrl+S to write rdir/r.ts');
  assert(!existsSync(join(root, 'r.ts')), 'the old r.ts is never recreated');
  log('drag replace: the replaced tab goes, the moved one takes its path with its buffer ✓');
  await closeTab(page, 'r.ts');
}

const editModel = (page, uri, text) =>
  page.evaluate(
    ({ u, t }) => {
      const m = window.monaco.editor
        .getModels()
        .find((x) => decodeURIComponent(x.uri.toString()).toLowerCase() === u);
      m.applyEdits([{ range: new window.monaco.Range(1, 1, 1, 1), text: t }]);
    },
    { u: uri, t: text },
  );

/** Same move, but the DESTINATION tab has unsaved edits: nothing may be lost silently. */
async function phaseDragReplaceDirty({ app, page, root, log, shot }) {
  await setMode(page, 'off');
  await row(page, 'qdir').click();
  const qRows = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^q\.ts$/ }),
  });
  await qRows.nth(1).waitFor({ state: 'attached', timeout: 10000 });
  await qRows.nth(0).dblclick(); // qdir/q.ts
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
  await qRows.nth(1).dblclick(); // q.ts at the root
  await waitFor(
    async () => (await modelUris(page)).filter((u) => u.endsWith('/q.ts')).length === 2,
    'both q.ts models',
  );
  const uris = await modelUris(page);
  const destUri = uris.find((u) => u.endsWith('/qdir/q.ts'));
  const srcUri = uris.find((u) => u.endsWith('/q.ts') && !u.includes('/qdir/'));
  await editModel(page, destUri, 'D');
  await editModel(page, srcUri, 'S');

  await qRows.nth(1).dragTo(row(page, 'qdir'));
  await page.waitForSelector('.confirm .btn--danger', { state: 'visible', timeout: 8000 });
  await page.locator('.confirm .btn--danger', { hasText: 'Replace' }).click();
  await waitFor(() => !existsSync(join(root, 'q.ts')), 'the move on disk', 10000);
  await sleep(500);
  assert(disk(root, 'qdir/q.ts') === 'src\n', 'the moved file is on disk, unwritten');
  assert(
    (await modelValueAt(page, '/qdir/q.ts')) === 'Ddest\n',
    'the destination tab keeps its unsaved edits',
  );
  const srcValue = await page.evaluate(
    (u) =>
      window.monaco.editor
        .getModels()
        .find((x) => decodeURIComponent(x.uri.toString()).toLowerCase() === u)
        ?.getValue() ?? null,
    srcUri,
  );
  assert(srcValue === 'Ssrc\n', `the moved tab keeps its edits too (${JSON.stringify(srcValue)})`);
  assert(
    (await page.locator('.tabbar [role="tab"]', { hasText: 'q.ts' }).count()) === 2,
    'both tabs stay open',
  );
  const dest = page.locator('.tabbar [role="tab"]', { hasText: 'q.ts' });
  await dest.nth(0).click();
  await page
    .locator('.viewer__banner--warn', { hasText: 'changed on disk' })
    .waitFor({ timeout: 5000 });
  await shot('drag-replace-dirty-destination');
  assert(
    (await writesTo(app, 'q.ts')).length === 0,
    'nothing was written while resolving the move',
  );
  log('drag replace, dirty destination: its edits stay, paused as changed on disk ✓');

  await page.locator('.viewer__banner--warn button', { hasText: 'Reload from disk' }).click();
  await waitFor(
    async () => (await modelValueAt(page, '/qdir/q.ts')) === 'src\n',
    'Reload to take the moved file',
  );
  log('drag replace, dirty destination: Reload takes the moved file ✓');
}

/** The TS worker's semantic diagnostic codes for the model at `tail` (2307 = cannot find module).
 *  Asked of the worker directly: the app turns Monaco's own semantic markers off. */
const semanticCodes = (page, tail) =>
  page.evaluate(async (t) => {
    const m = window.monaco.editor
      .getModels()
      .find((x) => decodeURIComponent(x.uri.toString()).toLowerCase().endsWith(t));
    const worker = await (await window.monaco.typescript.getTypeScriptWorker())(m.uri);
    const diags = await worker.getSemanticDiagnostics(m.uri.toString());
    return diags.map((d) => String(d.code));
  }, tail);

async function phaseTsIndex({ page, log }) {
  await openFile(page, 'use.ts');
  // lib.ts is never opened: it reaches the worker only as an extraLib.
  await waitFor(
    async () => !(await semanticCodes(page, '/use.ts')).includes('2307'),
    'the import to resolve while lib.ts is where it says',
    20000,
  );
  await renameRow(page, 'lib.ts', 'lib2.ts');
  await waitFor(
    async () => (await semanticCodes(page, '/use.ts')).includes('2307'),
    'the import of the renamed file to report "Cannot find module"',
    20000,
  );
  log('ts index: an import of the renamed path no longer resolves ✓');

  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors().find((e) => e.hasTextFocus());
    ed.setPosition({ lineNumber: 2, column: 19 });
  });
  await page.keyboard.press('F12');
  await sleep(2500);
  assert((await tab(page, 'lib.ts').count()) === 0, 'F12 opens no tab on the removed lib.ts');
  log('ts index: F12 on it opens no dead tab ✓');
  await closeTab(page, 'use.ts');
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
  await shot('truncated-typed');
  const bannerHit = await page.evaluate(() => {
    const b = document.querySelector('.viewer__banner');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
    return !!hit && b.contains(hit);
  });
  assert(bannerHit, 'nothing covers the large-file banner after an edit attempt');
  assert(
    (await page.locator('.monaco-editor-overlaymessage').count()) === 0,
    'no read-only popup stacked on the banner',
  );
  assert(
    (await page.locator('.viewer__banner[role="note"]').count()) === 1,
    'the banner is a note',
  );
  const said = await page.locator('.viewer__announce').allTextContents();
  assert(
    said.some((t) => t.includes('read-only')),
    `the edit attempt is announced once (${JSON.stringify(said)})`,
  );
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
    'fdel/x.ts': 'one\n',
    'fdel/y.ts': 'one\n',
    'dd.ts': 'one\n',
    'u.ts': 'one\n',
    'm.ts': 'one\n',
    'mdir/keep.txt': 'k\n',
    'r.ts': 'src\n',
    'q.ts': 'src\n',
    'qdir/q.ts': 'dest\n',
    'rdir/r.ts': 'dest\n',
    'lib.ts': 'export const lib = 1;\n',
    'use.ts': "import { lib } from './lib';\nexport const x = lib;\n",
    'big.txt': BIG,
  },
  phases: {
    fileRename: phaseFileRename,
    tsIndex: phaseTsIndex,
    folderRename: phaseFolderRename,
    undoRename: phaseUndoRename,
    dragMove: phaseDragMove,
    dragReplace: phaseDragReplace,
    dragReplaceDirty: phaseDragReplaceDirty,
    deleteOpen: phaseDeleteOpen,
    folderDelete: phaseFolderDelete,
    dirtyDelete: phaseDirtyDelete,
    truncated: phaseTruncated,
  },
});

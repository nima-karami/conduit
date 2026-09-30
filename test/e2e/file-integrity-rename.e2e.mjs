/**
 * File integrity against the real built app: an Explorer rename (F2) of an open, dirty file or of
 * the folder holding one retargets the tab — buffer, dirty state, cursor and the auto-save writer
 * all follow the new path, and nothing is ever written back to the old one. Undo of a rename
 * retargets the same way, and a renamed path leaves the TS project.
 *
 * Run after a fresh build: `npm run build` then `npm run e2e -- file-integrity-rename`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  activate,
  closeTab,
  disk,
  isDirty,
  openFile,
  setMode,
  sleep,
  tab,
  waitFor,
  writesTo,
} from './auto-save-helpers.mjs';
import {
  cursorIn,
  editAt,
  modelUris,
  modelValueAt,
  renameRow,
  row,
  runFileIntegrity,
} from './file-integrity-helpers.mjs';
import { assert } from './harness.mjs';

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

runFileIntegrity('file-integrity-rename', {
  fileRename: phaseFileRename,
  tsIndex: phaseTsIndex,
  folderRename: phaseFolderRename,
  undoRename: phaseUndoRename,
});

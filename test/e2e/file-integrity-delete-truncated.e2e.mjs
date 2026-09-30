/**
 * File integrity against the real built app: deleting a file or folder closes its clean tabs; a
 * dirty one stays open, marked deleted, and nothing recreates it until the user picks Overwrite.
 * And a > 2 MB file, which the host only loads the head of, can never be written over the full
 * file by Ctrl+S, Save All, close→Save or auto save.
 *
 * Run after a fresh build: `npm run build` then `npm run e2e -- file-integrity-delete-truncated`.
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
  setMode,
  sleep,
  tab,
  waitFor,
  writesTo,
} from './auto-save-helpers.mjs';
import {
  BIG,
  deletedBanner,
  deleteRow,
  editAt,
  modelValueAt,
  overwrite,
  row,
  runFileIntegrity,
} from './file-integrity-helpers.mjs';
import { assert } from './harness.mjs';

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

runFileIntegrity('file-integrity-delete-truncated', {
  deleteOpen: phaseDeleteOpen,
  folderDelete: phaseFolderDelete,
  dirtyDelete: phaseDirtyDelete,
  truncated: phaseTruncated,
});

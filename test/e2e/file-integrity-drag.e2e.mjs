/**
 * File integrity against the real built app: an Explorer drag-move of an open, dirty file
 * retargets its tab with its buffer, and a move that replaces a file open in another tab never
 * silently loses either buffer.
 *
 * Run after a fresh build: `npm run build` then `npm run e2e -- file-integrity-drag`.
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
  editAt,
  editModel,
  modelUris,
  modelValueAt,
  row,
  runFileIntegrity,
} from './file-integrity-helpers.mjs';
import { assert } from './harness.mjs';

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

runFileIntegrity('file-integrity-drag', {
  dragMove: phaseDragMove,
  dragReplace: phaseDragReplace,
  dragReplaceDirty: phaseDragReplaceDirty,
});

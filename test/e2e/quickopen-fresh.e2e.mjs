/**
 * Quick-open's file list follows the disk (search-scope runtime QA F1, F4). The renderer used to
 * ask the host for each folder's list once, so a file created after the first Ctrl+P never
 * appeared and a deleted one stayed pickable, opening "File could not be read.". The host now
 * pushes `fileIndexChanged` and the palette asks again, past the host's 5 s index cache.
 *
 * One plain repo (the case QA found it in), so the list is `git ls-files`: `gone.ts` is deleted
 * from the worktree without staging, which `--cached` alone still listed (F4).
 *
 *   1. palette used, then closed → create `fresh-one.ts`, delete `gone.ts` → reopen: the new file
 *      is listed, the deleted one is not;
 *   2. palette open → create `fresh-two.ts`: it appears without reopening.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, removeDir, runScenario } from './harness.mjs';

/** The watcher's debounce, the host's coalesced signal and one `ls-files`, with headroom. */
const REFRESH_BUDGET_MS = 15000;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });

/** The palette's Files rows (titles), in the page. */
function fileRows() {
  const group = [...document.querySelectorAll('.palette__group')].find(
    (g) => g.querySelector('.palette__gtitle')?.textContent === 'Files',
  );
  return [...(group?.querySelectorAll('.palette__row .palette__title') ?? [])].map(
    (t) => t.textContent ?? '',
  );
}

async function openPalette(page, query) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill(query);
}

async function closePalette(page) {
  await page.keyboard.press('Escape');
  await page.locator('.palette__input').waitFor({ state: 'detached', timeout: 5000 });
}

/** Waits until every `present` name ends some Files row and no `absent` one does. */
async function waitRows(page, { present = [], absent = [] }, what) {
  try {
    await page.waitForFunction(
      ({ present, absent }) => {
        const group = [...document.querySelectorAll('.palette__group')].find(
          (g) => g.querySelector('.palette__gtitle')?.textContent === 'Files',
        );
        const rows = [...(group?.querySelectorAll('.palette__row .palette__title') ?? [])].map(
          (t) => t.textContent ?? '',
        );
        const has = (n) => rows.some((r) => r.endsWith(n));
        return present.every(has) && !absent.some(has);
      },
      { present, absent },
      { timeout: REFRESH_BUDGET_MS },
    );
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    assert(false, `${what} (palette Files rows: ${JSON.stringify(await page.evaluate(fileRows))})`);
  }
}

runScenario('quickopen-fresh', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-quickopen-fresh-')));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'kept.ts'), 'export const kept = 1;\n');
    writeFileSync(join(root, 'gone.ts'), 'export const gone = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'seed');

    await openSession(page, { path: root.replace(/\\/g, '/') });
    await openPalette(page, '.ts');
    await waitRows(
      page,
      { present: ['kept.ts', 'gone.ts'] },
      'the first palette open lists kept.ts and gone.ts',
    );
    await closePalette(page);
    log('palette used once: kept.ts + gone.ts listed');

    writeFileSync(join(root, 'fresh-one.ts'), 'export const one = 1;\n');
    rmSync(join(root, 'gone.ts'));
    // Reopen only after the host had time to signal; the reopen itself must then re-ask.
    await page.waitForTimeout(2000);
    await openPalette(page, '.ts');
    await waitRows(
      page,
      { present: ['fresh-one.ts'], absent: ['gone.ts'] },
      'after a create and an unstaged delete, the reopened palette lists fresh-one.ts and not gone.ts',
    );
    log('reopened: fresh-one.ts in, deleted gone.ts out ✓');

    writeFileSync(join(root, 'fresh-two.ts'), 'export const two = 2;\n');
    await waitRows(
      page,
      { present: ['fresh-two.ts'] },
      'a file created while the palette is open appears without reopening it',
    );
    await closePalette(page);
    log('palette open: fresh-two.ts appeared live ✓');
  } finally {
    await closeApp(app, page);
    await removeDir(root);
  }
});

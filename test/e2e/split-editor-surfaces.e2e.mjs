/**
 * split-editor-surfaces — split-editor scenarios that need their own profile or a special surface
 * (docs/specs/2026-09-28-split-editor.md §7). One launch, with `autoSave: 'onFocusChange'` seeded:
 *   P9  leaving b.ts in the right group saves it (viewLeave), while the left group still shows it
 *       clean.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession } from './harness.mjs';
import {
  explorer,
  G,
  openFromExplorer,
  shownTab,
  sleep,
  tabOf,
  waitShown,
} from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor-surfaces] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('split-editor-surfaces');

const repo = mkdtempSync(join(tmpdir(), 'conduit-split-surf-'));
writeFileSync(join(repo, 'a.ts'), 'export const answer = 42;\n');
writeFileSync(join(repo, 'b.ts'), "import { answer } from './a';\nexport const b = answer;\n");
const repoArg = repo.replace(/\\/g, '/');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-split-surf-ud-'));
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { autoSave: 'onFocusChange' } }),
);

async function phaseViewLeave(page) {
  await openFromExplorer(page, 'b.ts');
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'b.ts', 'P9');
  await explorer(page, 'a.ts', 'dblclick');
  await waitShown(page, 2, 'a.ts', 'P9');
  await tabOf(page, 2, 'b.ts').click();
  await waitShown(page, 2, 'b.ts', 'P9');
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// p9');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 2, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'P9: both b.ts tabs should be dirty'));
  await tabOf(page, 2, 'a.ts').click();
  await waitShown(page, 2, 'a.ts', 'P9');
  const saved = () => readFileSync(join(repo, 'b.ts'), 'utf8').includes('// p9');
  const deadline = Date.now() + 8000;
  while (!saved() && Date.now() < deadline) await sleep(200);
  assert(saved(), 'P9: b.ts was not saved when the right group left it');
  assert((await shownTab(page, 1)) === 'b.ts', 'P9: the left group no longer shows b.ts');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 0, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'P9: b.ts is still dirty after the save'));
  log('P9 ✓ leaving the file in one group saves it; the other group shows it clean');
}

let launched = null;
let code = 0;
try {
  launched = await launchApp({ userDataDir });
  const { page } = launched;
  await openSession(page, { path: repoArg });
  await phaseViewLeave(page);
  log('PASS ✓ split-editor-surfaces: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor-surfaces] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor-surfaces] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
process.exit(code);

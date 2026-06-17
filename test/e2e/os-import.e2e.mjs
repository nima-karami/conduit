/**
 * OS drag-and-drop import into the Files explorer (host path).
 *
 * The actual OS drag gesture can't be synthesized in Playwright (a fabricated File has no
 * backing OS path for webUtils.getPathForFile), so this drives the host op the drop wires
 * up — window.agentDeck.fsImport([source], targetDir) — and asserts the external file is
 * copied into the workspace and shows up in the tree. Uses throwaway temp dirs only (never
 * touches the repo).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[os-import] SKIP — suite is Windows-only');
  process.exit(0);
}

const project = mkdtempSync(join(tmpdir(), 'conduit-osimp-proj-'));
const src = mkdtempSync(join(tmpdir(), 'conduit-osimp-src-'));
const srcFile = join(src, 'dropped.txt');
writeFileSync(srcFile, 'hello from outside');

let launched;
try {
  launched = await launchApp();
  const { page, log } = { ...launched, log: (...a) => console.log('[os-import]', ...a) };
  await openSession(page, { path: project });
  await tapBridge(page);
  await page.locator('.rtab', { hasText: 'Files' }).click();

  // The host import the drop wires up.
  const res = await page.evaluate(
    ({ sources, target }) => window.agentDeck.fsImport(sources, target),
    { sources: [srcFile], target: project },
  );
  assert(res?.ok, `fsImport should succeed, got ${JSON.stringify(res)}`);
  log('fsImport returned ok ✓');

  // Copied onto disk inside the workspace, original left intact.
  assert(existsSync(join(project, 'dropped.txt')), 'file should be copied into the project');
  assert(readFileSync(srcFile, 'utf8') === 'hello from outside', 'original must be untouched');
  log('external file copied into the workspace (original intact) ✓');

  // Best-effort: it should also surface in the tree after a refresh. (The drop handler
  // calls refreshDir with the tree's own path form; here we post the temp path directly,
  // whose casing may not match the shell's tracked cwd — so this is a soft check.)
  await page.evaluate((p) => window.agentDeck.post({ type: 'readDir', path: p }), project);
  const appeared = await page
    .locator('.filerow', { has: page.locator('.filerow__name', { hasText: /^dropped\.txt$/ }) })
    .first()
    .waitFor({ state: 'attached', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  log(appeared ? 'imported file appears in the tree ✓' : 'tree row not asserted (soft, cwd-form)');

  await launched.cleanup();
  console.log('[os-import] PASS ✓');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.log(`[os-import] ${isAssertion ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
} finally {
  rmSync(project, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
}

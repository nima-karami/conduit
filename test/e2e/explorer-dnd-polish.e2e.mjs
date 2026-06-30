/**
 * Explorer drag-and-drop & rename polish (spec 2026-06-29-explorer-dnd-rename-polish).
 *
 * Real OS drag gestures can't be synthesized in Playwright, so this drives the host ops the
 * UI wires up plus the keyboard path that IS drivable:
 *   1. fsMove conflict policy — default EEXIST (discriminable), replace, keep-both ("(n)").
 *   2. fsMutate case-only rename (Foo.ts → foo.ts) survives via the two-step temp rename.
 *   3. DOM: F2 on a file row opens the rename input with only the STEM selected (extension kept).
 *
 * Uses throwaway temp dirs only (never touches the repo). Windows-only.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[explorer-dnd-polish] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = (...a) => console.log('[explorer-dnd-polish]', ...a);
const project = mkdtempSync(join(tmpdir(), 'conduit-dndpolish-'));
// A file used by the DOM F2 test, present before the tree first loads.
writeFileSync(join(project, 'component.tsx'), 'export const X = 1;\n');

let launched;
try {
  launched = await launchApp();
  const { page } = launched;
  await openSession(page, { path: project.replace(/\\/g, '/') });
  await tapBridge(page);

  const move = (from, to, opts) =>
    page.evaluate(({ from, to, opts }) => window.agentDeck.fsMove(from, to, opts), {
      from: from.replace(/\\/g, '/'),
      to: to.replace(/\\/g, '/'),
      opts,
    });

  // ── Test 1: conflict policy ────────────────────────────────────────────────
  const src = join(project, 'src');
  const dst = join(project, 'dst');
  writeFileSync(join(project, '_seed'), ''); // ensure project is a workspace root
  const { mkdirSync } = await import('node:fs');
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(src, 'a.ts'), 'NEW');
  writeFileSync(join(dst, 'a.ts'), 'OLD');

  const eexist = await move(join(src, 'a.ts'), join(dst, 'a.ts'));
  assert(
    eexist?.ok === false && eexist.code === 'EEXIST',
    `expected EEXIST, got ${JSON.stringify(eexist)}`,
  );
  assert(existsSync(join(src, 'a.ts')), 'source must be untouched on EEXIST');
  log('default policy returns discriminable EEXIST ✓');

  const replaced = await move(join(src, 'a.ts'), join(dst, 'a.ts'), { onConflict: 'replace' });
  assert(replaced?.ok === true, `replace should succeed, got ${JSON.stringify(replaced)}`);
  assert(
    readFileSync(join(dst, 'a.ts'), 'utf8') === 'NEW',
    'replace must overwrite the destination',
  );
  assert(!existsSync(join(src, 'a.ts')), 'source removed after a move');
  log('replace overwrites the destination ✓');

  writeFileSync(join(src, 'a.ts'), 'NEWER'); // re-seed source
  const kept = await move(join(src, 'a.ts'), join(dst, 'a.ts'), { onConflict: 'rename' });
  assert(
    kept?.ok === true && /a \(1\)\.ts$/.test(kept.path),
    `keep-both path wrong: ${JSON.stringify(kept)}`,
  );
  assert(existsSync(join(dst, 'a (1).ts')), 'keep-both writes a (1).ts');
  assert(readFileSync(join(dst, 'a.ts'), 'utf8') === 'NEW', 'keep-both leaves the original');
  log('keep-both writes a non-colliding "(1)" name ✓');

  // ── Test 2: case-only rename ───────────────────────────────────────────────
  writeFileSync(join(project, 'Foo.ts'), 'casetest');
  const cased = await page.evaluate(
    ({ from, to }) => window.agentDeck.fsMutate({ op: 'rename', from, to }),
    {
      from: join(project, 'Foo.ts').replace(/\\/g, '/'),
      to: join(project, 'foo.ts').replace(/\\/g, '/'),
    },
  );
  assert(cased?.ok === true, `case rename should succeed, got ${JSON.stringify(cased)}`);
  assert(
    readFileSync(join(project, 'foo.ts'), 'utf8') === 'casetest',
    'content survives case rename',
  );
  assert(readdirSync(project).includes('foo.ts'), 'directory shows the lower-cased name');
  log('case-only rename (Foo.ts → foo.ts) survives ✓');

  // ── Test 3: F2 selects only the filename stem ──────────────────────────────
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.evaluate(
    (p) => window.agentDeck.post({ type: 'readDir', path: p }),
    project.replace(/\\/g, '/'),
  );
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^component\.tsx$/ }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 8000 });
  // Ctrl-click selects the row (seats the anchor) WITHOUT opening it — keeps Monaco out of
  // teardown so cleanup stays fast.
  await row.first().click({ modifiers: ['Control'] });
  // Dispatch F2 as a bubbling keydown (React's delegated listener catches it on the tree).
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.filerow')].find(
      (r) => r.querySelector('.filerow__name')?.textContent === 'component.tsx',
    );
    el?.focus();
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  });
  const sel = await page
    .locator('.filerow__input')
    .first()
    .evaluate((el) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }));
  assert(sel.value === 'component.tsx', `rename input value wrong: ${JSON.stringify(sel)}`);
  assert(
    sel.start === 0 && sel.end === 'component'.length,
    `stem not selected: ${JSON.stringify(sel)}`,
  );
  log('F2 opens rename with only the stem selected ✓');

  // The session opened above is running, so a bare app.close() would hang on the quit-guard —
  // use closeApp, which answers the in-app confirm.
  await closeApp(launched.app, page);
  console.log('[explorer-dnd-polish] PASS ✓');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  console.log(`[explorer-dnd-polish] ${isAssertion ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
} finally {
  rmSync(project, { recursive: true, force: true });
}

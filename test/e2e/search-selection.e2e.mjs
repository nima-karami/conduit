/**
 * search-selection — Mod+Shift+F seeds global search from the current selection.
 *
 * VS Code / Cursor parity. The unit tests cover the classifier and the registry in isolation;
 * this proves the whole chain in the real app: a Monaco selection reaches the search box,
 * and a MULTI-LINE selection survives — which is the part that could not work before, because
 * the field was an <input> and HTML's value-sanitization strips newlines from `.value`.
 *
 * Windows-only, matching the suite.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[search-selection] SKIP — suite is Windows-only');
  process.exit(0);
}

const FIXTURE = [
  'const alpha = 1;',
  'const bravo = 2;',
  'const charlie = 3;',
  '',
  'export { alpha, bravo, charlie };',
].join('\n');

const queryValue = (page) =>
  page.evaluate(() => document.querySelector('.search__inputbox textarea')?.value ?? null);

runScenario('search-selection', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-seed-'));
  writeFileSync(join(root, 'source.ts'), FIXTURE);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  await page.locator('.filerow', { hasText: 'source.ts' }).first().click();
  await page.waitForSelector('.docpanel .monaco-editor', { timeout: 25000 });

  // Wait for Monaco to REGISTER an editor, not merely for its DOM to exist. Under suite load
  // the element mounts well before `monaco.editor.getEditors()` returns one, and every call
  // below is optional-chained — so without this the selection silently never gets set and the
  // assertion fails on an empty seed that has nothing to do with the feature.
  await page.waitForFunction(() => (window.monaco?.editor?.getEditors?.() ?? []).length > 0, null, {
    timeout: 25000,
  });

  /**
   * Select a range through Monaco's own API — the feature reads `editor.getSelection()`, so that
   * is the thing under test — and do not return until the editor AGREES the selection took.
   * Asserting the precondition is what stops a load-induced no-op from being read as a failure
   * of the behaviour.
   */
  const select = async (startLineNumber, endLineNumber, endColumn) => {
    await page.evaluate(
      (sel) => {
        const ed = window.monaco.editor.getEditors()[0];
        ed.setSelection({ startColumn: 1, ...sel });
        ed.focus();
      },
      { startLineNumber, endLineNumber, endColumn },
    );
    await page.waitForFunction(
      (want) => {
        const ed = window.monaco?.editor?.getEditors?.()[0];
        const r = ed?.getSelection();
        return (
          !!r &&
          r.startLineNumber === want.startLineNumber &&
          r.endLineNumber === want.endLineNumber
        );
      },
      { startLineNumber, endLineNumber },
      { timeout: 10000 },
    );
  };

  /** Press the chord and wait for a seed to ARRIVE, rather than sleeping and hoping. */
  const seedAndRead = async () => {
    await page.keyboard.press('Control+Shift+F');
    await page.waitForSelector('.search__inputbox textarea', { timeout: 15000 });
    await page.waitForFunction(
      () => (document.querySelector('.search__inputbox textarea')?.value ?? '') !== '',
      null,
      { timeout: 10000 },
    );
    return queryValue(page);
  };

  // ── Single-line selection ────────────────────────────────────────────────
  await select(2, 2, 17);
  const single = await seedAndRead();
  log(`seeded (single line): ${JSON.stringify(single)}`);
  assert(
    single === 'const bravo = 2;',
    `the search box must hold the selected line, got ${JSON.stringify(single)}`,
  );
  log('a Monaco selection seeds global search ✓');

  // ── Multi-line selection — the part that was impossible before ───────────
  // Clear first: seedAndRead waits for a NON-EMPTY box, so a leftover single-line seed would
  // satisfy that wait instantly and the multi-line assertion would read stale text.
  await page.evaluate(() => {
    const ta = document.querySelector('.search__inputbox textarea');
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.waitForFunction(
    () => (document.querySelector('.search__inputbox textarea')?.value ?? '') === '',
    null,
    { timeout: 10000 },
  );

  await select(1, 2, 17);
  const multi = await seedAndRead();
  log(`seeded (two lines): ${JSON.stringify(multi)}`);
  assert(
    multi?.includes('\n'),
    `a multi-line selection must reach the box WITH its newline — an <input> would have stripped it. Got ${JSON.stringify(multi)}`,
  );
  assert(
    multi === 'const alpha = 1;\nconst bravo = 2;',
    `both lines must survive intact, got ${JSON.stringify(multi)}`,
  );
  log('a multi-line selection survives into the query, newline intact ✓');

  // And the engine can actually match it — a result for a two-line query proves the
  // per-line scan was really bypassed, not just that the box accepted the text.
  await page.waitForTimeout(1200);
  const hits = await page.locator('.searchmatch').count();
  log(`results for the two-line query: ${hits}`);
  assert(hits > 0, 'a multi-line query must actually find its span in the file');
  log('the multi-line query matches across the line boundary ✓');

  log('PASS — selection seeds the search box, multi-line survives and matches');
});

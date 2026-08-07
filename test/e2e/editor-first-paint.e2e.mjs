/**
 * A code file's tokenizer must be ready BEFORE its editor exists (navigation-parity spec
 * §3f) — that readiness is what removes the flash of unstyled text on open.
 *
 * Monaco wires every basic language's grammar behind an async factory
 * (`registerTokensProviderFactory` + a dynamic `import()`), so its first render of a file is
 * null-tokenized until that promise resolves. `ensureTokenizer` registers the grammar
 * synchronously instead, before the model and the editor are created.
 *
 * Why this is asserted through `monaco.editor.tokenize` rather than by watching the DOM:
 * `tokenize` is synchronous and consults the registry WITHOUT resolving the lazy factory, so
 * it answers exactly the question that matters — "was the grammar already registered?" —
 * with no timing in the loop. Measuring the paint itself is not viable here: the smoke
 * harness runs the window hidden, which throttles rAF to ~1fps, so every render lands
 * roughly a second late whether or not the tokenizer was ready.
 *
 * Run: node test/e2e/run-smoke.mjs editor-first-paint   (needs `npm run build` first)
 */
import { assert, openSession, REPO, runScenario } from './harness.mjs';

const fileRowByName = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

/** Distinct token types monaco reports for a snippet — [''] when nothing is registered. */
const tokenTypes = (page, lang) =>
  page.evaluate(
    (language) => [
      ...new Set(
        (window.monaco.editor.tokenize('const x = "a"; // c', language)[0] ?? []).map(
          (t) => t.type,
        ),
      ),
    ],
    lang,
  );

runScenario('editor-first-paint', async ({ page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow__name', { timeout: 20000 });

  // Baseline: with no code file open, nothing has registered the TypeScript grammar, so the
  // lazy factory is all there is and a synchronous tokenize comes back empty. This is the
  // state every first open used to paint in.
  const before = await tokenTypes(page, 'typescript');
  log(`token types before opening a file: ${JSON.stringify(before)}`);
  assert(
    before.length <= 1,
    `expected no grammar registered before the first open, got ${JSON.stringify(before)}`,
  );

  await fileRowByName(page, 'webview').first().click();
  await fileRowByName(page, 'app.tsx').first().waitFor({ state: 'attached', timeout: 20000 });
  await fileRowByName(page, 'app.tsx').first().click();
  await page.waitForFunction(
    () =>
      window.monaco?.editor.getEditors().some((e) => e.getModel()?.uri.path.endsWith('app.tsx')),
    null,
    { timeout: 30000 },
  );

  const after = await tokenTypes(page, 'typescript');
  log(`token types after opening app.tsx: ${JSON.stringify(after)}`);
  assert(
    after.includes('keyword.ts') && after.includes('string.ts') && after.includes('comment.ts'),
    `grammar was not registered synchronously on open, got ${JSON.stringify(after)}`,
  );

  // And it reaches the paint. Polled generously because the hidden window's rAF is throttled;
  // this is the catastrophic-regression guard (highlighting gone entirely), not a timing one.
  await page.waitForFunction(
    () => {
      const classes = new Set();
      for (const span of document.querySelectorAll('.view-line span[class^="mtk"]'))
        for (const c of span.classList) if (c.startsWith('mtk')) classes.add(c);
      return classes.size > 1;
    },
    null,
    { timeout: 30000, polling: 500 },
  );
  log('rendered lines are syntax-coloured ✓');

  // A language with no bundled Monarch grammar must not throw or block the open — it falls
  // back to kicking monaco's own factory early.
  const md = await tokenTypes(page, 'markdown');
  log(`markdown token types: ${JSON.stringify(md)}`);
  assert(md.length > 0, 'tokenizing an unopened language should not throw');
});

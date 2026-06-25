/**
 * Go-to-definition indexing smoke (real app).
 *
 * Regression guard for the flaky go-to-def fix: the host used to cap the indexed source
 * set at 400 files, so the TS worker had no model for files past the cap and silently
 * resolved nothing. This repo has ~400 source files — right at the edge. Asserts the real
 * host now indexes the whole tree (>400 models) AND that the live TS worker resolves a
 * cross-file definition end-to-end.
 *
 * Run: node test/e2e/run-smoke.mjs goto-index   (needs `npm run build` first)
 */
import { assert, openSession, REPO, runScenario } from './harness.mjs';

runScenario('goto-index', async ({ page, log }) => {
  await openSession(page, { path: REPO });

  // Post the same indexProject the renderer fires on first code-file open (the open-file
  // gating is unchanged; this exercises the HOST handler + IPC + renderer indexModels —
  // the path that was fixed). The reply drives indexModels, creating one model per file.
  await page.evaluate(
    (root) => window.agentDeck.post({ type: 'indexProject', root }),
    REPO.replace(/\\/g, '/'),
  );

  // Wait for the host's projectFiles reply to populate Monaco models (async).
  await page.waitForFunction(() => (window.monaco?.editor.getModels().length ?? 0) > 400, null, {
    timeout: 30000,
  });
  const modelCount = await page.evaluate(() => window.monaco.editor.getModels().length);
  log(`indexed models: ${modelCount}`);
  assert(modelCount > 400, `expected >400 indexed models (cap fix), got ${modelCount}`);

  // Cross-file resolution through the live worker: app.tsx imports `matchCombo` from
  // ./shortcuts; resolving it must land in shortcuts.ts (a different file). Poll because
  // the worker may still be warming.
  const def = await page
    .waitForFunction(
      async () => {
        const monaco = window.monaco;
        const model = monaco.editor
          .getModels()
          .find((m) => m.uri.toString().endsWith('webview/app.tsx'));
        if (!model) return null;
        const off = model.getValue().indexOf('matchCombo');
        if (off < 0) return null;
        try {
          const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
          const worker = await getWorker(model.uri);
          const defs = await worker.getDefinitionAtPosition(model.uri.toString(), off + 2);
          const d = defs?.[0];
          return d ? d.fileName : null;
        } catch {
          return null;
        }
      },
      null,
      { timeout: 30000, polling: 500 },
    )
    .then((h) => h.jsonValue());

  log(`matchCombo resolved to: ${def}`);
  assert(typeof def === 'string', 'expected a cross-file definition for matchCombo');
  assert(
    def.endsWith('shortcuts.ts') && !def.endsWith('app.tsx'),
    `expected matchCombo to resolve into shortcuts.ts, got ${def}`,
  );
});

/**
 * Cross-file navigation, end to end in the real app (navigation-parity spec).
 *
 * Guards the three things that were actually broken:
 *  1. The index must cover the WHOLE source tree. It used to be built from a walk capped at
 *     4000 files of any type, breadth-first, so deep source directories were silently never
 *     offered to the indexer — and a definition in one of them could never resolve.
 *  2. Project sources reach the language worker as extraLibs, NOT as a Monaco model per file.
 *     A model per file is what made opening a file janky; the model count staying small while
 *     the extraLib count is large is the whole point.
 *  3. Monaco's BUILT-IN Go to Definition navigates across files. It never did before, because
 *     the standalone editor service refuses to open any URI but the current model's — the fix
 *     is the registered editor opener, and this is what proves it's wired.
 *
 * Run: node test/e2e/run-smoke.mjs goto-index   (needs `npm run build` first)
 */
import { assert, openSession, REPO, runScenario } from './harness.mjs';

const fileRowByName = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

runScenario('goto-index', async ({ page, log }) => {
  await openSession(page, { path: REPO });

  // Indexing now starts when the session opens — no need to poke it, and no need to open a
  // file first. Wait for the stream to finish (the last chunk sets done).
  await page.waitForFunction(
    () => {
      const libs = window.monaco?.languages.typescript.typescriptDefaults.getExtraLibs();
      return libs ? Object.keys(libs).length > 400 : false;
    },
    null,
    { timeout: 60000 },
  );
  const indexed = await page.evaluate(
    () => Object.keys(window.monaco.languages.typescript.typescriptDefaults.getExtraLibs()).length,
  );
  log(`indexed source files (extraLibs): ${indexed}`);
  assert(indexed > 400, `expected >400 indexed files, got ${indexed}`);

  // The regression that keeps coming back: files past the old caps, in deep directories.
  const deep = await page.evaluate(() =>
    Object.keys(window.monaco.languages.typescript.typescriptDefaults.getExtraLibs()).filter((k) =>
      k.endsWith('webview/components/code-viewer.tsx'),
    ),
  );
  assert(deep.length === 1, `expected the deep source file to be indexed, got ${deep.length}`);
  log('deep source directory indexed ✓');

  // No model-per-file. Before the parity work this number WAS the index size.
  const modelsBeforeOpen = await page.evaluate(() => window.monaco.editor.getModels().length);
  log(`monaco models before opening anything: ${modelsBeforeOpen}`);
  assert(
    modelsBeforeOpen < 50,
    `project sources must not each get a model; got ${modelsBeforeOpen} models`,
  );

  // Open a real file through the app's own open path (explorer click).
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  await fileRowByName(page, 'webview').first().click();
  await fileRowByName(page, 'app.tsx').first().click();
  await page.waitForFunction(
    () =>
      window.monaco?.editor.getEditors().some((e) => e.getModel()?.uri.path.endsWith('app.tsx')),
    null,
    { timeout: 30000 },
  );
  log('app.tsx open in an editor ✓');

  // Put the cursor on a symbol imported from another file and run Monaco's BUILT-IN command.
  // app.tsx imports `matchCombo` from ./shortcuts.
  const placed = await page.evaluate(() => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.path.endsWith('app.tsx'));
    const model = editor?.getModel();
    if (!editor || !model) return false;
    const off = model.getValue().indexOf('matchCombo(');
    if (off < 0) return false;
    editor.setPosition(model.getPositionAt(off + 2));
    editor.focus();
    return true;
  });
  assert(placed, 'could not place the cursor on a cross-file symbol in app.tsx');

  // Run the real command, not the worker call: this exercises the provider AND the opener,
  // which is the pair that was broken. Retried from Node (not via waitForFunction, whose
  // predicate result would be a pending Promise handle) because the worker may still be
  // building its program on the first attempt — one unhurried retry each way is plenty.
  let landed = null;
  for (let attempt = 0; attempt < 8 && !landed; attempt++) {
    landed = await page.evaluate(async () => {
      const editor = window.monaco.editor
        .getEditors()
        .find((e) => e.getModel()?.uri.path.endsWith('app.tsx'));
      // The action F12 is bound to — it wraps monaco's built-in command with the indicator
      // and the deadline. The built-in itself is a COMMAND, not an editor action, so
      // `getAction('editor.action.revealDefinition')` is null by design.
      if (editor) await editor.getAction('conduit.goToDefinition')?.run();
      // The opener routes through React state, so the tab appears a tick later.
      await new Promise((r) => setTimeout(r, 1500));
      return (
        window.monaco.editor
          .getEditors()
          .map((e) => e.getModel()?.uri.path ?? '')
          .find((p) => p.endsWith('shortcuts.ts')) ?? null
      );
    });
  }

  log(`Go to Definition landed in: ${landed}`);
  assert(typeof landed === 'string', 'built-in Go to Definition did not open the defining file');
  // …and in the PROJECT's copy. A checkout carrying a git worktree or agent scratch tree under a
  // dot-directory holds a second copy of every file; landing there still ends in "shortcuts.ts"
  // while sending the user to a stale duplicate (src/source-index.ts).
  assert(
    !/\/\.[^/]+\//.test(landed),
    `resolved into a tool-state copy, not the project's own file: ${landed}`,
  );

  // The target's model was materialised on demand — one file, not the whole index.
  const modelsAfter = await page.evaluate(() => window.monaco.editor.getModels().length);
  log(`monaco models after navigating: ${modelsAfter}`);
  assert(modelsAfter < 50, `navigation must not materialise the index; got ${modelsAfter} models`);

  // The rest of the VS Code set is bound and reaches a provider. Type Definition and
  // Implementations are the two monaco's TS mode never registered — they only answer at all
  // because of the worker subclass in webview/ts.worker.ts, so a silent regression there
  // (a renamed monaco internal, a worker that fails to boot) has to fail here.
  const bound = await page.evaluate(() => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.path.endsWith('shortcuts.ts'));
    return [
      'conduit.goToDefinition',
      'conduit.goToTypeDefinition',
      'conduit.goToImplementations',
      'conduit.goToReferences',
      'conduit.peekDefinition',
      'conduit.findAllReferences',
    ].filter((id) => !editor?.getAction(id));
  });
  assert(bound.length === 0, `navigation actions missing from the editor: ${bound.join(', ')}`);
  log('full navigation command set bound ✓');

  const providers = await page.evaluate(async () => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.path.endsWith('shortcuts.ts'));
    const model = editor.getModel();
    const off = model.getValue().indexOf('export function matchCombo');
    editor.setPosition(model.getPositionAt(off + 18));
    const getWorker = await window.monaco.languages.typescript.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    const at = model.getOffsetAt(editor.getPosition());
    return {
      typeDef: typeof worker.getTypeDefinitionAtPosition === 'function',
      impl: typeof worker.getImplementationAtPosition === 'function',
      refs: (await worker.getReferencesAtPosition(model.uri.toString(), at))?.length ?? 0,
    };
  });
  log(`worker extensions: ${JSON.stringify(providers)}`);
  assert(providers.typeDef, 'the custom worker is missing getTypeDefinitionAtPosition');
  assert(providers.impl, 'the custom worker is missing getImplementationAtPosition');
  // References span the project, so they can only be found in files the worker holds as
  // extraLibs — i.e. this also proves the index is visible to a whole-program query.
  assert(providers.refs > 1, `expected cross-file references, got ${providers.refs}`);
  log('type-definition / implementation / cross-file references available ✓');
});

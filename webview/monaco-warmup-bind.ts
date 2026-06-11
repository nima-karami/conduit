// Monaco-bound entry point for TS-worker warm-up. Isolated from `monaco-warmup.ts`
// (pure helpers) so the node Vitest env never has to load `monaco-editor`. Imported by
// app.tsx after the first project-files index.

import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { warmTypeScriptWorker } from './monaco-warmup';

/** TS/JS language ids whose worker backs go-to-definition. */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

/**
 * Bind warmTypeScriptWorker to the live Monaco APIs. Call after project files are
 * indexed; safe to call repeatedly (once-guarded inside warmTypeScriptWorker). Issues
 * the same getDefinitionAtPosition call a real goto uses so the worker pre-loads the
 * cross-file resolution path before the user's first manual go-to-definition.
 */
export function warmWorkerFromMonaco(): void {
  void warmTypeScriptWorker({
    getModels: () =>
      monaco.editor
        .getModels()
        .map((m) => ({ uri: m.uri.toString(), languageId: m.getLanguageId() })),
    isTsLang: (id) => TS_LANGS.has(id),
    getTypeScriptWorker: async () => {
      const getWorker = await monacoTs.getTypeScriptWorker();
      return async (uri: string) => getWorker(monaco.Uri.parse(uri));
    },
  });
}

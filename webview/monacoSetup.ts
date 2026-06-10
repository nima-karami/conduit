import * as monaco from 'monaco-editor';
import { typescript as monacoTypescript } from 'monaco-editor';

// Point Monaco at its bundled worker (out/monaco-editor.worker.js, loaded relative
// to index.html). Must run before any monaco-editor import is used.
type MonacoEnv = { getWorker: () => Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker: () => new Worker('./monaco-editor.worker.js'),
};

// We bundle only the editor worker (read-only viewer; language workers/go-to-def
// are deferred). Disable TS/JS diagnostics so the console isn't spammed with
// "Missing requestHandler: getSyntacticDiagnostics" worker errors.
monacoTypescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});
monacoTypescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

// Suppress unused-import warning: monaco is imported for its side-effects
// (registers language providers, sets up the editor runtime).
void monaco;

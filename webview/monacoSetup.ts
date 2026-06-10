import * as monaco from 'monaco-editor';
import { typescript as monacoTypescript } from 'monaco-editor';

// Point Monaco at its bundled workers (loaded relative to index.html). Must run
// before any monaco-editor import is used. The TypeScript/JavaScript language
// worker powers go-to-definition, hover and references; everything else uses the
// editor worker.
type MonacoEnv = { getWorker: (workerId: string, label: string) => Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === 'typescript' || label === 'javascript'
      ? new Worker('./ts.worker.js')
      : new Worker('./monaco-editor.worker.js'),
};

// Keep red error squiggles off (we open one file at a time, so cross-file symbols
// would otherwise look "missing"), but the language service stays active so
// go-to-definition / hover / peek work within a file.
monacoTypescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});
monacoTypescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

// Expose monaco for debugging / verification (e.g. querying the TS language worker).
(window as unknown as { monaco: typeof monaco }).monaco = monaco;

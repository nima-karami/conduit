// Point Monaco at its bundled worker (out/monaco-editor.worker.js, loaded relative
// to index.html). Must run before any monaco-editor import is used.
type MonacoEnv = { getWorker: () => Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker: () => new Worker('./monaco-editor.worker.js'),
};

import * as monaco from 'monaco-editor';
import { typescript as monacoTypescript } from 'monaco-editor';
import { BASE_COMPILER_OPTIONS } from '../src/tsconfig-map';

// Must run before any monaco-editor import is used. The TS/JS language worker powers
// go-to-definition, hover and references; everything else uses the editor worker.
type MonacoEnv = { getWorker: (workerId: string, label: string) => Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === 'typescript' || label === 'javascript'
      ? new Worker('./ts.worker.js')
      : new Worker('./monaco-editor.worker.js'),
};

// Keep red error squiggles off, but the language service stays active so
// go-to-definition / hover / peek still work across files once models load.
monacoTypescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});
monacoTypescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

// Baseline options until a project's own tsconfig arrives with the index (ts-project.ts).
// Shared with that path so there is one set of defaults, not two that can drift.
monacoTypescript.typescriptDefaults.setCompilerOptions(BASE_COMPILER_OPTIONS);
monacoTypescript.javascriptDefaults.setCompilerOptions(BASE_COMPILER_OPTIONS);
monacoTypescript.typescriptDefaults.setEagerModelSync(true);
monacoTypescript.javascriptDefaults.setEagerModelSync(true);

// Monaco measures its font once and caches it for the window, and never watches web fonts. The
// editor font arrives from a stylesheet after the first editor has measured the fallback, which
// leaves every caret, selection and hit-test drifting from the painted text. Also covers a mono
// font picked later in Settings.
document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());

// Expose monaco for debugging / verification (e.g. querying the TS language worker).
(window as unknown as { monaco: typeof monaco }).monaco = monaco;

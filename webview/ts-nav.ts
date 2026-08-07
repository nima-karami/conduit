/**
 * The navigation commands Monaco's TypeScript mode doesn't provide, plus the wrapper that
 * makes every navigation bounded and honest.
 *
 * `tsMode.js` registers definition and reference providers but neither type-definition nor
 * implementation, so `editor.action.goToTypeDefinition` and `editor.action.goToImplementation`
 * have nothing to call. The providers below fill that in against the worker methods added in
 * `webview/ts.worker.ts`.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3d–§3e.
 */

import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import type { TsDefinitionInfo } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js';
import { langFromPath } from '../src/lang';
import { withTimeout } from '../src/with-timeout';
import { executeEditorCommand } from './monaco-commands';
import { ensureTokenizer } from './monaco-languages';
import { openedCount } from './monaco-opener';
import { gotoInflight } from './monaco-warmup';
import { pushToast } from './toast-store';
import { indexStatus, isIndexReady } from './ts-project';

/** Language ids whose navigation is backed by the TS/JS worker. */
export const TS_LANGS = new Set(['typescript', 'javascript']);

/**
 * How long a navigation may run before we give up on it. Generous enough for a cold worker
 * building a program over a few thousand files, short enough that "Resolving definition…"
 * can never be a permanent fixture — which is exactly how this failed before.
 */
const NAV_TIMEOUT_MS = 6000;

/** The extra methods `webview/ts.worker.ts` adds to monaco's TypeScript worker. */
interface ConduitWorker {
  getTypeDefinitionAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined>;
  getImplementationAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined>;
}

async function workerFor(model: monaco.editor.ITextModel): Promise<ConduitWorker> {
  const getWorker =
    model.getLanguageId() === 'javascript'
      ? await monacoTs.getJavaScriptWorker()
      : await monacoTs.getTypeScriptWorker();
  // Crossing a worker boundary: the proxy carries our subclass's methods at runtime, but
  // monaco's published type describes only its own.
  return (await getWorker(model.uri)) as unknown as ConduitWorker;
}

/**
 * Resolve a target file to a model so a span can be turned into a range. Mirrors what
 * Monaco's own adapters do via `LibFiles.getOrCreateModel`, except the model is created with
 * the file's REAL language rather than a hardcoded `typescript`.
 */
function targetModel(fileName: string): monaco.editor.ITextModel | null {
  const uri = monaco.Uri.parse(fileName);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  const lib = monacoTs.typescriptDefaults.getExtraLibs()[fileName];
  if (!lib) return null;
  const language = langFromPath(uri.path);
  ensureTokenizer(language);
  return monaco.editor.createModel(lib.content, language, uri);
}

function toLocations(entries: TsDefinitionInfo[] | undefined): monaco.languages.Location[] {
  const out: monaco.languages.Location[] = [];
  for (const entry of entries ?? []) {
    const model = targetModel(entry.fileName);
    // A target we hold no content for is dropped rather than opened as an empty tab; an
    // empty result then reports not-found (or still-indexing) through runNavCommand.
    if (!model) continue;
    const start = model.getPositionAt(entry.textSpan.start);
    const end = model.getPositionAt(entry.textSpan.start + entry.textSpan.length);
    out.push({
      uri: model.uri,
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    });
  }
  return out;
}

type Lookup = (
  worker: ConduitWorker,
  fileName: string,
  offset: number,
) => Promise<TsDefinitionInfo[] | undefined>;

async function provide(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  lookup: Lookup,
): Promise<monaco.languages.Location[] | undefined> {
  if (model.isDisposed()) return undefined;
  gotoInflight.begin();
  try {
    const worker = await workerFor(model);
    if (model.isDisposed()) return undefined;
    const entries = await withTimeout(
      lookup(worker, model.uri.toString(), model.getOffsetAt(position)),
      NAV_TIMEOUT_MS,
      undefined,
    );
    return model.isDisposed() ? undefined : toLocations(entries);
  } catch {
    return undefined;
  } finally {
    gotoInflight.end();
  }
}

/** Register the type-definition and implementation providers for TS and JS. */
export function registerTsNavigationProviders(): monaco.IDisposable[] {
  const disposables: monaco.IDisposable[] = [];
  for (const language of TS_LANGS) {
    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(language, {
        provideTypeDefinition: (model, position) =>
          provide(model, position, (w, f, o) => w.getTypeDefinitionAtPosition(f, o)),
      }),
      monaco.languages.registerImplementationProvider(language, {
        provideImplementation: (model, position) =>
          provide(model, position, (w, f, o) => w.getImplementationAtPosition(f, o)),
      }),
    );
  }
  return disposables;
}

/**
 * Run a built-in navigation action with an indicator, a deadline, and an honest outcome.
 *
 * Monaco shows its own "no definition found" message at the cursor, which is the parity
 * behaviour we want — but it can't know the difference between "there is no definition" and
 * "the project hasn't finished indexing". That distinction is the whole point of this
 * wrapper: if nothing moved and the index is still streaming, say so instead of letting the
 * user conclude the feature is broken.
 */
export async function runNavCommand(
  editor: monaco.editor.ICodeEditor,
  commandId: string,
): Promise<void> {
  // These commands resolve their target from the FOCUSED editor, so a menu click (which
  // moved focus to the menu) has to hand it back first.
  editor.focus();
  const beforeUri = editor.getModel()?.uri.toString();
  const beforePos = editor.getPosition();
  const beforeOpens = openedCount();
  const TIMED_OUT = Symbol('timed-out');
  gotoInflight.begin();
  try {
    const outcome = await withTimeout<unknown>(
      executeEditorCommand(editor, commandId),
      NAV_TIMEOUT_MS,
      TIMED_OUT,
    );
    if (outcome === TIMED_OUT) {
      pushToast({ message: 'Couldn’t resolve in time. Try again.', variant: 'error' });
      return;
    }
    if (isIndexReady()) return;
    const afterPos = editor.getPosition();
    const moved =
      openedCount() !== beforeOpens ||
      editor.getModel()?.uri.toString() !== beforeUri ||
      afterPos?.lineNumber !== beforePos?.lineNumber ||
      afterPos?.column !== beforePos?.column;
    if (moved) return;
    const { loaded, total } = indexStatus();
    pushToast({
      message: total
        ? `Still indexing this project (${loaded} of ${total} files). Try again in a moment.`
        : 'This project hasn’t been indexed yet — cross-file navigation is still warming up.',
      variant: 'info',
    });
  } finally {
    gotoInflight.end();
  }
}

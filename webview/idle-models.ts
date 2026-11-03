import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { createIdleLru } from './idle-model-lru';
import { disposeWhenDetached } from './model-lifetime';

/** Idle (tab closed) models kept for cross-file resolution; see {@link createIdleLru}. */
export const MAX_IDLE_MODELS = 50;

// Only a model whose file the TS project index also holds is ever disposed: the worker falls back
// to that extraLib (kept current on save by refreshIndexedFile), so resolution is unchanged. A
// model with no extraLib behind it is the only copy of that text and stays.
const indexed = (uri: string) => uri in monacoTs.typescriptDefaults.getExtraLibs();

const lru = createIdleLru<string>(MAX_IDLE_MODELS, (uri) => {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model && indexed(uri)) disposeWhenDetached(model);
});

export function markModelActive(model: monaco.editor.ITextModel): void {
  lru.markActive(model.uri.toString());
}

/** Call after the viewer's editor is disposed. A second group may still show the model. */
export function markModelIdle(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  if (monaco.editor.getEditors().some((e) => e.getModel() === model)) return;
  const uri = model.uri.toString();
  if (indexed(uri)) lru.markIdle(uri);
}

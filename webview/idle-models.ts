import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { getDirtySnapshot } from './dirty-store';
import type { OpenDoc } from './docs';
import { fileSaves } from './file-saves';
import { createIdleModels } from './idle-model-lru';
import { disposeWhenDetached } from './model-lifetime';
import { fileUri } from './project-index';

/** Idle (tab closed) models kept for cross-file resolution; see {@link createIdleModels}. */
export const MAX_IDLE_MODELS = 50;

// Only a model whose file the TS project index also holds is ever disposed: the worker falls back
// to that extraLib (kept current on save by refreshIndexedFile), so resolution is unchanged. A
// model with no extraLib behind it is the only copy of that text and stays.
const indexed = (path: string) =>
  fileUri(path).toString() in monacoTs.typescriptDefaults.getExtraLibs();

const models = createIdleModels({
  cap: MAX_IDLE_MODELS,
  // A save entry holds an adapter over the model: disposing under it breaks save-all and the quit
  // guard ("Model is disposed!"), and a reopen would read disk as clean, losing the edits.
  canDispose: (path) =>
    !getDirtySnapshot().has(path) && fileSaves.getStatus(path) === undefined && indexed(path),
  dispose: (path) => {
    const model = monaco.editor.getModel(fileUri(path));
    if (model) disposeWhenDetached(model);
  },
});

/** Call with the window's docs whenever they change. */
export function syncOpenFileTabs(docs: readonly OpenDoc[]): void {
  const open = new Set<string>();
  for (const d of docs) if (d.kind === 'file') open.add(d.path);
  models.syncOpenPaths(open);
}

import * as monaco from 'monaco-editor';

/**
 * Dispose `model` now, or once the last editor showing it is gone. An editor still showing it is
 * a viewer about to unmount, and its unmount capture of the view state needs a model to read.
 */
export function disposeWhenDetached(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  const showing = monaco.editor.getEditors().filter((e) => e.getModel() === model);
  if (showing.length === 0) {
    model.dispose();
    return;
  }
  let left = showing.length;
  for (const e of showing) {
    const sub = e.onDidDispose(() => {
      sub.dispose();
      left -= 1;
      if (left === 0 && !model.isDisposed()) model.dispose();
    });
  }
}

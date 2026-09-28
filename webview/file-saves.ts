import * as monaco from 'monaco-editor';
import { useSyncExternalStore } from 'react';
import { canSave, post, writeFile } from './bridge';
import { clearDirty, getDirtySnapshot, updateDirty } from './dirty-store';
import { createFileSaves, type FileSaveStatus, type FileSaves } from './file-save-controller';
import { fileUri } from './project-index';
import { notifySaved, registerSave } from './save-registry';
import { pushToast } from './toast-store';
import { refreshIndexedFile } from './ts-project';

/** The app's one save store, wired to Monaco, the bridge and the renderer's shared stores. */
export const fileSaves: FileSaves = createFileSaves({
  getModel: (p) => monaco.editor.getModel(fileUri(p)),
  write: writeFile,
  canWrite: canSave,
  isMarkedDirty: (p) => getDirtySnapshot().has(p),
  setDirty: updateDirty,
  clearDirty,
  register: registerSave,
  onSaved: (p, c) => {
    // app.tsx's files map re-renders markdown views without a host round-trip (K3)…
    notifySaved(p, c);
    // …and files that resolve INTO this one navigate against what was just written.
    refreshIndexedFile(p, c);
  },
  requestRead: (p) => post({ type: 'readFile', path: p }),
  toast: (message) => pushToast({ message, variant: 'error' }),
  setTimer: (cb, ms) => window.setTimeout(cb, ms),
  clearTimer: (h) => window.clearTimeout(h as number),
});

export function useFileSaveStatus(path: string): FileSaveStatus | undefined {
  return useSyncExternalStore(fileSaves.subscribe, () => fileSaves.getStatus(path));
}

export function useFileSaveStatuses(): ReadonlyMap<string, FileSaveStatus> {
  return useSyncExternalStore(fileSaves.subscribe, fileSaves.getStatusSnapshot);
}

let docCloser: ((path: string) => void) | null = null;

/** App registers how a path's file tab is closed (the deleted-on-disk banner's Close). */
export function setDocCloser(fn: ((path: string) => void) | null): void {
  docCloser = fn;
}

export function closeDocForPath(path: string): void {
  docCloser?.(path);
}

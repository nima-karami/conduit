import * as monaco from 'monaco-editor';
import { useSyncExternalStore } from 'react';
import type { WriteResult } from '../src/path-guard';
import type { FileContentDTO, RemoteWriteOutcome } from '../src/protocol';
import { clearDirty, getDirtySnapshot, updateDirty } from './dirty-store';
import {
  createFileSaves,
  type FileSaveDeps,
  type FileSaveStatus,
  type FileSaves,
  type SaveModel,
} from './file-save-controller';
import { requestHost } from './host-request';
import { MACHINES_STR } from './machines-strings';
import { remoteModelUri } from './project-index';
import { type ReadOnlyState, readOnlyState, remoteReadOnlyState } from './read-only-doc';
import { REMOTE_TIMEOUT, type RemoteReadResult, readRemoteFile } from './remote-files-store';
import { registerSave } from './save-registry';
import { pushToast } from './toast-store';
import { isTsLanguage } from './ts-nav';

/**
 * The save store for remote file tabs (plan CON-44 decisions 1, 3, 5, 8). Keyed by the doc id, so
 * a remote buffer never collides with a local file of the same path. The store owns each buffer's
 * model and save entry for as long as the tab is open, mounted or not. B decides every save by
 * content: each write names the hash B last reported, and a mismatch comes back as a conflict.
 */

export interface RemoteBufferRef {
  key: string;
  machineId: string;
  sessionId: string;
  path: string;
  machineName: string;
}

export interface RemoteWriteRequest {
  machineId: string;
  sessionId: string;
  path: string;
  data: string;
  expect: string | null;
}

export interface RemoteFileSavesDeps {
  /** A new buffer's model, holding `text`. */
  createModel(ref: RemoteBufferRef, text: string, language: string): SaveModel;
  /** The live model for this ref, if one exists. */
  getModel(ref: RemoteBufferRef): SaveModel | null;
  disposeModel(model: SaveModel): void;
  /** Posts a write to B and resolves with B's answer, or `error` when it never came. */
  postWrite(req: RemoteWriteRequest): Promise<RemoteWriteOutcome>;
  read(machineId: string, sessionId: string, path: string): Promise<RemoteReadResult>;
  toast(message: string): void;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isMarkedDirty(key: string): boolean;
  setDirty(key: string, baseline: string, buffer: string): void;
  clearDirty(key: string): void;
  register: FileSaveDeps['register'];
}

export interface RemoteFileSaves extends FileSaves {
  /** Open or refresh a buffer from a read B answered. */
  open(ref: RemoteBufferRef, file: FileContentDTO): void;
  /** The tab closed: drop its save entry, dirty flag, hash and model. */
  close(key: string): void;
  modelOf(key: string): SaveModel | null;
  /** Overwrite B's file with the buffer, naming the hash B reported for the conflict. */
  reapply(key: string): Promise<boolean>;
  /** B's current text for a conflicted buffer's diff, read fresh; null when it can't be read. */
  readCurrent(key: string): Promise<string | null>;
}

interface RemoteBuffer {
  ref: RemoteBufferRef;
  model: SaveModel;
  /** The hash B reported for the content the buffer's baseline holds. null when B reported none
   *  (a read-only buffer) or, after a Re-apply, that the file is gone: the next write creates it. */
  hash: string | null;
  /** Set by a conflicted write: the hash B reports for its file now, null when it is gone. */
  conflict: { currentHash: string | null } | null;
}

/** A remote buffer's read-only lock, or null when it is writable; the editor and the store share it. */
export function remoteReadOnlyOf(file: FileContentDTO, machineName: string): ReadOnlyState | null {
  const lock = readOnlyState(file);
  if (lock !== null) return lock;
  // An older B cannot save, so its file is shown as the machine's and never written from here.
  if (file.hash === undefined || file.readOnlyReason === 'remote') {
    return remoteReadOnlyState(machineName);
  }
  return null;
}

export function createRemoteFileSaves(deps: RemoteFileSavesDeps): RemoteFileSaves {
  const buffers = new Map<string, RemoteBuffer>();

  const write = async (key: string, content: string): Promise<WriteResult> => {
    const b = buffers.get(key);
    if (!b) throw new Error(`no remote buffer for ${key}`);
    const outcome = await deps.postWrite({
      machineId: b.ref.machineId,
      sessionId: b.ref.sessionId,
      path: b.ref.path,
      data: content,
      expect: b.hash,
    });
    switch (outcome.kind) {
      case 'written':
        b.hash = outcome.hash;
        b.conflict = null;
        return { ok: true, path: key };
      case 'conflict':
        b.conflict = { currentHash: outcome.currentHash };
        return {
          ok: false,
          error: MACHINES_STR.remoteFileChanged(b.ref.machineName),
          conflict: outcome.currentHash === null ? 'deleted' : 'changed',
        };
      case 'error':
        return { ok: false, error: MACHINES_STR.remoteSaveError(outcome.error, b.ref.machineName) };
    }
  };

  const files = createFileSaves({
    getModel: (key) => buffers.get(key)?.model ?? null,
    write,
    canWrite: true,
    isMarkedDirty: deps.isMarkedDirty,
    setDirty: deps.setDirty,
    clearDirty: deps.clearDirty,
    register: deps.register,
    // No local file listeners: a remote save changes nothing on this computer.
    onSaved: () => {},
    requestRead: (key) => {
      void reattach(key);
    },
    toast: deps.toast,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });

  const open = (ref: RemoteBufferRef, file: FileContentDTO): void => {
    const key = ref.key;
    // A binary or failed read has no text to edit.
    if (file.binary || file.error !== undefined) return;
    let b = buffers.get(key);
    // Refreshing a dirty buffer changes nothing: a save must still name the hash it loaded, so
    // B's newer file conflicts instead of being overwritten.
    if (b && deps.isMarkedDirty(key)) return;
    if (!b) {
      const model = deps.getModel(ref) ?? deps.createModel(ref, file.content, languageOf(file));
      b = { ref, model, hash: file.hash ?? null, conflict: null };
      buffers.set(key, b);
    } else {
      b.ref = ref;
      b.hash = file.hash ?? null;
    }
    files.attach(key, {
      diskContent: file.content,
      readOnly: remoteReadOnlyOf(file, ref.machineName),
    });
  };

  // Discard: reload has cleared the dirty flag, so this read takes B's file and hash as they are.
  async function reattach(key: string): Promise<void> {
    const b = buffers.get(key);
    if (!b) return;
    const r = await deps.read(b.ref.machineId, b.ref.sessionId, b.ref.path);
    if (buffers.get(key) !== b) return;
    if (!r.ok) {
      deps.toast(MACHINES_STR.remoteFileReloadFailed(b.ref.machineName));
      return;
    }
    open(b.ref, r.file);
  }

  return {
    ...files,
    open,

    close(key: string) {
      const b = buffers.get(key);
      files.dispose(key);
      deps.clearDirty(key);
      if (!b) return;
      buffers.delete(key);
      deps.disposeModel(b.model);
    },

    modelOf: (key: string) => buffers.get(key)?.model ?? null,

    async reapply(key: string): Promise<boolean> {
      const b = buffers.get(key);
      if (!b || b.conflict === null) return false;
      b.hash = b.conflict.currentHash;
      b.conflict = null;
      // A conflicted buffer takes only a 'force' save (auto-save-policy: a manual save is refused there).
      return files.save(key, 'force');
    },

    async readCurrent(key: string): Promise<string | null> {
      const b = buffers.get(key);
      if (!b) return null;
      const r = await deps.read(b.ref.machineId, b.ref.sessionId, b.ref.path);
      return r.ok ? r.file.content : null;
    },
  };
}

/** Monaco takes TypeScript only in the local project; a remote buffer is plain text there. */
function languageOf(file: FileContentDTO): string {
  return isTsLanguage(file.language) ? 'plaintext' : file.language;
}

// Each adapter is one Monaco model: the store rebinds its change listener when the identity changes.
const adapters = new WeakMap<monaco.editor.ITextModel, SaveModel>();
const rawModels = new WeakMap<SaveModel, monaco.editor.ITextModel>();

/** A model's text as it goes to disk; see file-saves.ts for the BOM rule. */
const diskText = (model: monaco.editor.ITextModel): string =>
  model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);

function adapterOf(model: monaco.editor.ITextModel): SaveModel {
  let adapter = adapters.get(model);
  if (!adapter) {
    adapter = {
      getValue: () => diskText(model),
      setValue: (value) => model.setValue(value),
      onDidChangeContent: (cb) => model.onDidChangeContent(cb),
    };
    adapters.set(model, adapter);
    rawModels.set(adapter, model);
  }
  return adapter;
}

const WRITE_TIMEOUT_MS = 45_000;

/** The app's save store for remote file tabs (manual save only: never configure() it). */
const remoteStore = createRemoteFileSaves({
  createModel: (ref, text, language) =>
    adapterOf(monaco.editor.createModel(text, language, remoteModelUri(ref.machineId, ref.path))),
  getModel: (ref) => {
    const model = monaco.editor.getModel(remoteModelUri(ref.machineId, ref.path));
    return model ? adapterOf(model) : null;
  },
  disposeModel: (model) => rawModels.get(model)?.dispose(),
  postWrite: async (req) => {
    const reply = await requestHost(
      (requestId) => ({ type: 'remoteFs:write', requestId, ...req }),
      ['remoteFs:written'],
      WRITE_TIMEOUT_MS,
    );
    return reply ? reply.result : { kind: 'error', error: REMOTE_TIMEOUT };
  },
  read: readRemoteFile,
  toast: (message) => pushToast({ message, variant: 'error' }),
  setTimer: (cb, ms) => window.setTimeout(cb, ms),
  clearTimer: (h) => window.clearTimeout(h as number),
  isMarkedDirty: (key) => getDirtySnapshot().has(key),
  setDirty: updateDirty,
  clearDirty,
  register: registerSave,
});

export const remoteFileSaves: FileSaves = remoteStore;

export function openRemoteBuffer(ref: RemoteBufferRef, file: FileContentDTO): void {
  remoteStore.open(ref, file);
}

export function remoteBufferModel(key: string): monaco.editor.ITextModel | null {
  const model = remoteStore.modelOf(key);
  return model ? (rawModels.get(model) ?? null) : null;
}

/** The tab closed: drop its save entry, dirty flag, hash and model. */
export function closeRemoteBuffer(key: string): void {
  remoteStore.close(key);
}

/** After a conflict: overwrite B's file with the buffer, naming the hash B reported. */
export function reapplyRemote(key: string): Promise<boolean> {
  return remoteStore.reapply(key);
}

/** B's current text for a conflicted buffer's diff, read fresh; null when it can't be read. */
export function readRemoteCurrent(key: string): Promise<string | null> {
  return remoteStore.readCurrent(key);
}

export function useRemoteSaveStatus(key: string | null): FileSaveStatus | undefined {
  return useSyncExternalStore(remoteFileSaves.subscribe, () =>
    key === null ? undefined : remoteFileSaves.getStatus(key),
  );
}

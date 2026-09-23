// Keeps the host's language-server doc table in step with the open tabs. Keyed on the TAB LIST,
// not on editor mounts: only the active tab's CodeViewer is mounted, but every open tab of a
// server language is a synced doc (plan "Sync is keyed on the tab list").
import * as monaco from 'monaco-editor';
import type { LspOp, LspPosition, LspReply } from '../src/lsp-protocol';
import { lspInvoke, subscribe } from './bridge';
import { applyLspStatus, seedLspState } from './lsp-status';
import { fileUri } from './project-index';

export interface LspDocInput {
  path: string;
  languageId: string;
  text: string;
}

export const LSP_CHANGE_DEBOUNCE_MS = 150;

interface SyncedDoc {
  path: string;
  /** Last version SENT to the host, and the text it carried. */
  version: number;
  text: string;
  serverKey: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  model: monaco.editor.ITextModel | null;
  modelSubs: monaco.IDisposable[];
}

const docs = new Map<string, SyncedDoc>();
const sentListeners = new Set<(path: string) => void>();

function detachModel(doc: SyncedDoc): void {
  for (const d of doc.modelSubs) d.dispose();
  doc.modelSubs = [];
  doc.model = null;
}

function attachModel(doc: SyncedDoc, model: monaco.editor.ITextModel): void {
  if (doc.model === model) return;
  detachModel(doc);
  doc.model = model;
  doc.modelSubs = [
    model.onDidChangeContent(() => schedule(doc)),
    model.onWillDispose(() => {
      if (doc.timer) sendNow(doc);
      detachModel(doc);
    }),
  ];
}

function schedule(doc: SyncedDoc): void {
  if (doc.timer) clearTimeout(doc.timer);
  doc.timer = setTimeout(() => {
    doc.timer = null;
    void sendNow(doc);
  }, LSP_CHANGE_DEBOUNCE_MS);
}

function sendText(doc: SyncedDoc, text: string): Promise<void> {
  if (text === doc.text) return Promise.resolve();
  doc.version++;
  doc.text = text;
  return lspInvoke({ type: 'lsp:change', path: doc.path, version: doc.version, text }).then(() => {
    for (const cb of sentListeners) cb(doc.path);
  });
}

function sendNow(doc: SyncedDoc): Promise<void> {
  if (doc.timer) clearTimeout(doc.timer);
  doc.timer = null;
  return doc.model ? sendText(doc, doc.model.getValue()) : Promise.resolve();
}

function modelFor(path: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModel(fileUri(path));
}

function open(input: LspDocInput): void {
  const doc: SyncedDoc = {
    path: input.path,
    version: 1,
    text: input.text,
    serverKey: null,
    timer: null,
    model: null,
    modelSubs: [],
  };
  docs.set(input.path, doc);
  const model = modelFor(input.path);
  if (model) attachModel(doc, model);
  void lspInvoke({
    type: 'lsp:open',
    path: input.path,
    languageId: input.languageId,
    version: 1,
    text: input.text,
  }).then((r) => {
    if (docs.get(input.path) !== doc) return;
    doc.serverKey = r.serverKey;
    for (const cb of sentListeners) cb(doc.path);
  });
}

function close(doc: SyncedDoc): void {
  if (doc.timer) clearTimeout(doc.timer);
  detachModel(doc);
  docs.delete(doc.path);
  void lspInvoke({ type: 'lsp:close', path: doc.path });
}

export function reconcileLspDocs(inputs: readonly LspDocInput[]): void {
  const want = new Map(inputs.map((d) => [d.path, d]));
  for (const doc of [...docs.values()]) if (!want.has(doc.path)) close(doc);
  for (const input of want.values()) {
    const doc = docs.get(input.path);
    if (!doc) open(input);
    else if (!doc.timer && input.text !== doc.text) void sendText(doc, input.text);
  }
}

export function isLspDocOpen(path: string): boolean {
  return docs.has(path);
}

export function serverKeyForDoc(path: string): string | null {
  return docs.get(path)?.serverKey ?? null;
}

/** Send the tab's debounced edit now, so a request that follows is answered against it. */
export function flushPending(path: string): Promise<void> {
  const doc = docs.get(path);
  return doc?.timer ? sendNow(doc) : Promise.resolve();
}

export function currentVersion(path: string): number | null {
  return docs.get(path)?.version ?? null;
}

/** The text last sent for an open tab — what the server answered against. */
export function syncedText(path: string): string | null {
  return docs.get(path)?.text ?? null;
}

/** Fires once the host holds new text for a tab — its open, then each change. */
export function subscribeLspDocSent(cb: (path: string) => void): () => void {
  sentListeners.add(cb);
  return () => sentListeners.delete(cb);
}

export function lspRequest(
  path: string,
  op: LspOp,
  pos: LspPosition,
  requestId: string,
): Promise<LspReply> {
  const doc = docs.get(path);
  if (!doc) return Promise.resolve({ kind: 'empty', adHocRoot: false });
  return lspInvoke({
    type: 'lsp:request',
    requestId,
    path,
    version: doc.version,
    op,
    line: pos.line,
    character: pos.character,
  });
}

export function initLspClient(): () => void {
  void lspInvoke({ type: 'lsp:statusSnapshot' }).then(seedLspState);
  const unsubscribe = subscribe((msg) => {
    if (msg.type === 'lsp:status') applyLspStatus(msg.status);
  });
  const created = monaco.editor.onDidCreateModel((model) => {
    const key = model.uri.toString();
    for (const doc of docs.values()) {
      if (fileUri(doc.path).toString() === key) attachModel(doc, model);
    }
  });
  return () => {
    unsubscribe();
    created.dispose();
  };
}

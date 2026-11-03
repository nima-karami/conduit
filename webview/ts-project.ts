/**
 * Hand the project's source files to Monaco's TypeScript worker, so navigation can resolve
 * across files that aren't open.
 *
 * The old approach created a Monaco MODEL per project file — hundreds of them, in one
 * synchronous loop, on the same main thread that was trying to paint the file the user had
 * just opened. That is unnecessary: the worker resolves modules out of `extraLibs` just as
 * happily (`TypeScriptWorker.fileExists` is `_getScriptText(path) !== undefined`, and
 * `getScriptFileNames()` concatenates the extraLib keys), and Monaco materialises a model
 * on demand for whichever file a navigation actually lands in
 * (`LibFiles.getOrCreateModel`). So: content to the worker, models only for open tabs.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3b.
 */

import { editor as monacoEditor, typescript as monacoTs } from 'monaco-editor';
import { pathBelow, renamedPath } from '../src/canonical-path';
import { folderKey } from '../src/folder-key';
import type { TsconfigDTO } from '../src/tsconfig-map';
import { toCompilerOptions } from '../src/tsconfig-map';
import { log } from './log';
import { disposeWhenDetached } from './model-lifetime';
import { warmLanguageWorker } from './monaco-warmup';
import { fileUri, pathForUri } from './project-index';
import { createIndexTracker, flushImmediately, type IndexProgress } from './ts-index-state';
import { CompilerOptionsRoot } from './ts-options-root';

export interface ProjectFilesChunk {
  root: string;
  files: { path: string; content: string; language: string }[];
  seq: number;
  total: number;
  done: boolean;
  skipped: number;
  capped: number;
  supplemental?: true;
  tsconfig?: TsconfigDTO;
}

/**
 * How long to wait for more chunks before handing them on. The priority wave (seq 0) and the
 * final chunk flush immediately; everything between them coalesces.
 */
const FLUSH_IDLE_MS = 250;

/**
 * Any change to the extraLib map re-posts the WHOLE map to each language worker (monaco's
 * `_updateExtraLibs` structured-clones every file), so a push per flush or per auto-save is a
 * full-project copy every few hundred ms. Pushes are rate-limited to one per interval.
 */
const PUSH_INTERVAL_MS = 1000;

/**
 * Source text the window may hand the workers, summed over roots. The worker holds every
 * extraLib as a root SourceFile (~5–10× the text once parsed) and the JS worker can hold a
 * second copy, so this bounds the workers near a GB; past it, the least recently active roots
 * leave first. `length` stands in for bytes: V8 stores ASCII source one byte per char.
 */
export const MAX_INDEXED_SOURCE_BYTES = 64 * 1024 * 1024;

interface IndexedFile {
  path: string;
  content: string;
}

/** Streamed, waiting for the flush that counts it as loaded for `root`. */
const pending = new Map<string, IndexedFile & { root: string }>();
/** Flushed, saved or moved, waiting for the next push. */
const outbox = new Map<string, IndexedFile>();
// What the workers hold, with the handles that take it out again: a rename or delete must remove
// the old path, and only the handle of the latest add can (monaco versions each extraLib).
const indexed = new Map<string, IndexedFile & { handles: { dispose(): void }[] }>();
let indexedBytes = 0;
/** Root keys each uri belongs to; it leaves when its last root does. Unowned is never evicted. */
const owners = new Map<string, Set<string>>();
/** Every root the index knows, with the project files it has loaded for it. */
const loadedByRoot = new Map<string, number>();
/** Evicted roots whose in-flight stream is ignored until they are expected again. */
const evicted = new Set<string>();
const lastActive = new Map<string, number>();
let activeClock = 0;
let activeRoots = new Set<string>();
const evictionListeners = new Set<(rootKey: string) => void>();
let budgetLogged = false;
let streamInOutbox = false;

const tracker = createIndexTracker();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPush = Number.NEGATIVE_INFINITY;

export function indexStatus(): IndexProgress {
  const s = tracker.status();
  // Streamed content still on its way to the worker is not "done": a miss then is "indexing".
  return { ...s, done: s.done && pending.size === 0 && !streamInOutbox };
}

/** True when navigation can honestly say "not found" rather than "still indexing". */
export function isIndexReady(): boolean {
  return indexStatus().done;
}

function own(uri: string, rootKey: string): void {
  const set = owners.get(uri);
  if (set) set.add(rootKey);
  else owners.set(uri, new Set([rootKey]));
}

function noteRoot(rootKey: string): void {
  if (!loadedByRoot.has(rootKey)) loadedByRoot.set(rootKey, 0);
  if (!lastActive.has(rootKey)) lastActive.set(rootKey, ++activeClock);
}

/** `root` is about to be (re-)indexed: a stream for it is wanted again. */
export function expectIndexRoot(root: string): void {
  const key = folderKey(root);
  evicted.delete(key);
  noteRoot(key);
}

/** The active session's present folders: the most recently active roots, and never trimmed. */
export function setActiveIndexRoots(roots: readonly string[]): void {
  activeRoots = new Set(roots.map(folderKey));
  for (const k of activeRoots) lastActive.set(k, ++activeClock);
}

/** Subscribe to roots leaving the index, so a once-guard on requesting them can be cleared. */
export function onIndexRootEvicted(listener: (rootKey: string) => void): () => void {
  evictionListeners.add(listener);
  return () => {
    evictionListeners.delete(listener);
  };
}

/** Drop every root no session in this window presents any more. */
export function retainIndexRoots(used: readonly string[]): void {
  const keep = new Set(used.map(folderKey));
  for (const key of [...loadedByRoot.keys()]) if (!keep.has(key)) evictRoot(key);
}

function dropIndexed(uri: string): void {
  const f = indexed.get(uri);
  if (!f) return;
  for (const h of f.handles) h.dispose();
  indexed.delete(uri);
  indexedBytes -= f.content.length;
}

function evictRoot(key: string): void {
  tracker.forget(key, loadedByRoot.get(key) ?? 0);
  loadedByRoot.delete(key);
  lastActive.delete(key);
  evicted.add(key);
  for (const [uri, set] of owners) {
    if (!set.delete(key) || set.size > 0) continue;
    owners.delete(uri);
    pending.delete(uri);
    outbox.delete(uri);
    dropIndexed(uri);
  }
  for (const l of evictionListeners) l(key);
}

function enforceBudget(): void {
  let trimmed = false;
  while (indexedBytes > MAX_INDEXED_SOURCE_BYTES) {
    let oldest: string | null = null;
    for (const key of loadedByRoot.keys()) {
      if (activeRoots.has(key)) continue;
      if (oldest === null || (lastActive.get(key) ?? 0) < (lastActive.get(oldest) ?? 0)) {
        oldest = key;
      }
    }
    if (oldest === null) break;
    evictRoot(oldest);
    trimmed = true;
  }
  if (trimmed && !budgetLogged) {
    budgetLogged = true;
    log.warn('ts-index', 'indexed source over budget; evicted least recently active roots', {
      budget: MAX_INDEXED_SOURCE_BYTES,
      indexedBytes,
    });
  }
}

function push(): void {
  if (pushTimer !== null) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  lastPush = Date.now();
  streamInOutbox = false;
  // One synchronous pass, so monaco's own setTimeout(0) coalescing makes it ONE re-post.
  for (const [uri, { path, content }] of outbox) {
    const prev = indexed.get(uri);
    // An unchanged re-add is a no-op in monaco whose handle removes nothing — keep the old one.
    if (prev?.content === content) continue;
    // Version-stable per file — unlike setExtraLibs, which re-versions every file on every call
    // and would invalidate the whole program per push.
    const handles = [
      monacoTs.typescriptDefaults.addExtraLib(content, uri),
      monacoTs.javascriptDefaults.addExtraLib(content, uri),
    ];
    indexedBytes += content.length - (prev?.content.length ?? 0);
    indexed.set(uri, { path, content, handles });
  }
  outbox.clear();
  enforceBudget();
}

/** At most one push per PUSH_INTERVAL_MS; immediate when the last one is old enough. */
function schedulePush(): void {
  if (pushTimer !== null) return;
  const wait = lastPush + PUSH_INTERVAL_MS - Date.now();
  if (wait <= 0) push();
  else pushTimer = setTimeout(push, wait);
}

/** Roots an out-of-index file belongs to: those containing it, else the active session's. */
function ownersFor(path: string): string[] {
  const k = folderKey(path);
  const containing = [...loadedByRoot.keys()].filter((r) => k === r || k.startsWith(`${r}/`));
  return containing.length ? containing : [...activeRoots];
}

/**
 * Push files the project index did NOT select — an on-demand module resolution (spec §1).
 * Pushed at once rather than on the rate limit: a navigation is waiting to retry against them.
 *
 * Deliberately does NOT touch the index tracker: `loaded`/`total` describe the PROJECT index,
 * and "N of M" would start lying the moment a package landed.
 */
export function addIndexedFiles(files: readonly IndexedFile[]): void {
  for (const f of files) {
    const uri = fileUri(f.path).toString();
    for (const r of ownersFor(f.path)) own(uri, r);
    outbox.set(uri, { path: f.path, content: f.content });
  }
  push();
}

type Taken = IndexedFile & { roots?: Set<string> };

/** Take everything at or under `path` out of the workers and the batches; returns both. */
function takeIndexed(
  path: string,
  keepOpen: (path: string) => boolean,
): { pushed: Taken[]; queued: (Taken & { root: string })[] } {
  const pushed = new Map<string, Taken>();
  const queued = new Map<string, Taken & { root: string }>();
  for (const [uri, f] of indexed) {
    if (pathBelow(f.path, path) === null) continue;
    pushed.set(uri, { path: f.path, content: f.content, roots: owners.get(uri) });
    dropIndexed(uri);
  }
  for (const [uri, f] of outbox) {
    if (pathBelow(f.path, path) === null) continue;
    // Newer than what the worker held.
    pushed.set(uri, { ...f, roots: owners.get(uri) });
    outbox.delete(uri);
  }
  for (const [uri, f] of pending) {
    if (pathBelow(f.path, path) === null) continue;
    pending.delete(uri);
    queued.set(uri, { ...f, roots: owners.get(uri) });
  }
  for (const uri of [...pushed.keys(), ...queued.keys()]) owners.delete(uri);
  // The worker reads a live model before an extraLib, so a model left on the path (a peeked or
  // closed file) would keep it resolving. An open tab's model is its buffer and stays.
  for (const m of monacoEditor.getModels()) {
    const p = pathForUri(m.uri);
    if (pathBelow(p, path) !== null && !keepOpen(p)) disposeWhenDetached(m);
  }
  return { pushed: [...pushed.values()], queued: [...queued.values()] };
}

/** `path` (a file or a folder) was deleted: it leaves the TS project. */
export function forgetIndexedPath(path: string, keepOpen: (path: string) => boolean): void {
  takeIndexed(path, keepOpen);
}

/** `from` was renamed to `to`: its files leave the project at the old path and join at the new. */
export function moveIndexedPath(
  from: string,
  to: string,
  keepOpen: (path: string) => boolean,
): void {
  const at = (p: string) => renamedPath(p, from, to) ?? p;
  const { pushed, queued } = takeIndexed(from, keepOpen);
  for (const f of pushed) {
    const uri = fileUri(at(f.path)).toString();
    for (const r of f.roots ?? []) own(uri, r);
    outbox.set(uri, { path: at(f.path), content: f.content });
  }
  // Still waiting for the flush, which is what counts them as loaded.
  for (const f of queued) {
    const uri = fileUri(at(f.path)).toString();
    for (const r of f.roots ?? []) own(uri, r);
    pending.set(uri, { path: at(f.path), content: f.content, root: f.root });
  }
  // The old path already left the worker; the new one lands in the same re-post.
  push();
}

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.size) return;
  for (const [uri, f] of pending) {
    outbox.set(uri, { path: f.path, content: f.content });
    loadedByRoot.set(f.root, (loadedByRoot.get(f.root) ?? 0) + 1);
  }
  tracker.markLoaded(pending.size);
  pending.clear();
  streamInOutbox = true;
  schedulePush();
  // Once-guarded: content alone doesn't start the worker, so the priority wave's flush is
  // where the cold start gets paid — in the background, before the user asks for anything.
  void warmLanguageWorker({
    acquire: async () => {
      const getWorker = await monacoTs.getTypeScriptWorker();
      await getWorker();
    },
  });
}

let appliedOptions = '';

// Compared before being set: `setCompilerOptions` fires `onDidChange`, and monaco's
// WorkerManager disposes the running worker on that event, so an unchanged re-apply (a
// re-index, a session switch between two roots with the same tsconfig) must not restart it.
const optionsRoot = new CompilerOptionsRoot((tsconfig) => {
  const options = toCompilerOptions(tsconfig, (p) => fileUri(p).toString());
  const serialized = JSON.stringify(options);
  if (serialized === appliedOptions) return;
  appliedOptions = serialized;
  monacoTs.typescriptDefaults.setCompilerOptions(options);
  monacoTs.javascriptDefaults.setCompilerOptions(options);
});

/** The active session's home: only its tsconfig drives compiler options (spec D8). */
export function setCompilerOptionsRoot(root: string | undefined): void {
  optionsRoot.setRoot(root);
}

/**
 * Apply one streamed chunk. Compiler options land BEFORE any content: applying them
 * mid-stream would restart the worker and throw away everything already pushed.
 */
export function applyProjectFiles(chunk: ProjectFilesChunk): void {
  const key = folderKey(chunk.root);
  if (evicted.has(key)) return;
  noteRoot(key);
  // A supplemental chunk carries no tsconfig, so treating one as chunk 0 would hand the worker
  // DEFAULT options — which restarts it and throws away the whole index it is topping up.
  if (chunk.seq === 0 && !chunk.supplemental) optionsRoot.noteChunk(chunk.root, chunk.tsconfig);
  tracker.note(key, {
    total: chunk.total,
    done: chunk.done,
    skipped: chunk.skipped,
    capped: chunk.capped,
    supplemental: chunk.supplemental,
  });
  for (const f of chunk.files) {
    const uri = fileUri(f.path).toString();
    own(uri, key);
    pending.set(uri, { path: f.path, content: f.content, root: key });
  }

  if (flushImmediately(chunk.seq, chunk.done)) {
    flush();
    return;
  }
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_IDLE_MS);
}

/**
 * Refresh one indexed file's content (e.g. after a save), so files that resolve INTO it see
 * the new text. A file open in a tab is a live model and already correct — this is for the
 * rest of the project. A file the index never held stays out: the fsChanged top-up is what
 * brings new files in.
 */
export function refreshIndexedFile(path: string, content: string): void {
  const uri = fileUri(path).toString();
  const queued = pending.get(uri);
  if (queued) {
    queued.content = content;
    return;
  }
  if (!indexed.has(uri) && !outbox.has(uri)) return;
  outbox.set(uri, { path, content });
  schedulePush();
}

export function __resetIndexForTest(): void {
  for (const uri of [...indexed.keys()]) dropIndexed(uri);
  for (const t of [flushTimer, pushTimer]) if (t !== null) clearTimeout(t);
  flushTimer = null;
  pushTimer = null;
  lastPush = Number.NEGATIVE_INFINITY;
  for (const m of [pending, outbox, owners, loadedByRoot, lastActive]) m.clear();
  evicted.clear();
  activeRoots = new Set();
  budgetLogged = false;
  streamInOutbox = false;
  tracker.reset();
}

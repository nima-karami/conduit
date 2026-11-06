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
import { canonicalPath, pathBelow, renamedPath } from '../src/canonical-path';
import { folderKey } from '../src/folder-key';
import { IGNORED_DIRS } from '../src/ignore-dirs';
import { resolveRelative, scanImports } from '../src/import-graph';
import { isOversizedForIndex, selectIndexCandidates } from '../src/source-index';
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
 * Source text the window may hand the TS worker, summed over roots. Measured on the built app
 * (memory audit pass 2): a language worker costs ~29× the extraLib text it holds (39 MB of
 * source → +1.18 GB private), so 24 MB keeps one worker near 700 MB. Past it, the least
 * recently active roots leave first. `length` stands in for bytes: V8 stores ASCII source one
 * byte per char.
 */
export const MAX_INDEXED_SOURCE_BYTES = 24 * 1024 * 1024;

/**
 * How many files the open JS models' import walk may visit. Same bound as the host's priority
 * wave (`src/import-graph.ts`); it only decides which `.ts` sources the JS worker gets.
 */
const JS_CLOSURE_CAP = 300;

interface IndexedFile {
  path: string;
  content: string;
}

interface Held extends IndexedFile {
  ts: { dispose(): void };
  /** Null while the JS worker doesn't hold this file. */
  js: { dispose(): void } | null;
}

/** Streamed, waiting for the flush that counts it as loaded for `root`. */
const pending = new Map<string, IndexedFile & { root: string }>();
/** Flushed, saved or moved, waiting for the next push. */
const outbox = new Map<string, IndexedFile>();
// What the workers hold, with the handles that take it out again: a rename or delete must remove
// the old path, and only the handle of the latest add can (monaco versions each extraLib).
const indexed = new Map<string, Held>();
let indexedBytes = 0;
/** On-demand resolutions: a navigation from either worker may be waiting on them. */
const jsPinned = new Set<string>();
/** Indexed TS sources the open JS models import, transitively. */
let jsPulled = new Set<string>();
let jsClosureDirty = true;
let jsModelsEdited = false;
let jsTracking: { dispose(): void }[] | null = null;
const importSignature = new WeakMap<monacoEditor.ITextModel, string>();
/** Monaco still lists a model while its onWillDispose runs, and a push can run inside it. */
const closing = new WeakSet<monacoEditor.ITextModel>();
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

/** Drop every root no session in this window presents any more — never the active session's:
 *  a briefly empty session list (a server restart) must not rebuild the whole index. */
export function retainIndexRoots(used: readonly string[]): void {
  const keep = new Set(used.map(folderKey));
  for (const key of [...loadedByRoot.keys()]) {
    if (!keep.has(key) && !activeRoots.has(key)) evictRoot(key);
  }
}

function dropIndexed(uri: string): void {
  const f = indexed.get(uri);
  if (!f) return;
  f.ts.dispose();
  f.js?.dispose();
  indexed.delete(uri);
  jsPinned.delete(uri);
  jsPulled.delete(uri);
  indexedBytes -= f.content.length;
  jsClosureDirty = true;
}

/**
 * What the JS worker gets without being asked: JS sources and declarations. A `.ts` source
 * reaches it only when an open JS model imports it, or a navigation resolved it — handing it
 * every `.ts` file made the first `.js` tab pay the whole index a second time.
 */
function isJsNative(path: string): boolean {
  return /\.(?:[mc]?jsx?|d\.[mc]?ts)$/i.test(path);
}

function wantsJs(uri: string, path: string): boolean {
  return isJsNative(path) || jsPinned.has(uri) || jsPulled.has(uri);
}

/** The spelling `src/import-graph.ts` resolves in. */
const slashPath = (p: string) => canonicalPath(p).replace(/\\/g, '/');

function openJsModels(): monacoEditor.ITextModel[] {
  return monacoEditor
    .getModels()
    .filter((m) => !m.isDisposed() && !closing.has(m) && m.getLanguageId() === 'javascript');
}

/** Indexed non-JS files reachable from the open JS models through relative imports, bounded. */
function jsClosure(models: readonly monacoEditor.ITextModel[]): Set<string> {
  const out = new Set<string>();
  if (!models.length) return out;
  const uriOf = new Map<string, string>();
  for (const [uri, f] of indexed) uriOf.set(slashPath(f.path), uri);
  const live = new Map<string, string>();
  const queue: string[] = [];
  for (const m of models) {
    const key = slashPath(pathForUri(m.uri));
    uriOf.set(key, m.uri.toString());
    live.set(key, m.getValue());
    queue.push(key);
  }
  const candidates = new Set(uriOf.keys());
  const seen = new Set(queue);
  for (let visited = 0; visited < JS_CLOSURE_CAP; visited++) {
    const key = queue.shift();
    if (key === undefined) break;
    const uri = uriOf.get(key);
    if (uri === undefined) continue;
    if (!isJsNative(key) && indexed.has(uri)) out.add(uri);
    const text = live.get(key) ?? indexed.get(uri)?.content;
    if (text === undefined) continue;
    for (const spec of scanImports(text)) {
      const target = resolveRelative(key, spec, candidates);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return out;
}

/** Re-walk only when a JS model's imports changed, not on every keystroke. */
function noteJsModelEdits(models: readonly monacoEditor.ITextModel[]): void {
  for (const m of models) {
    const sig = scanImports(m.getValue()).join('\n');
    if (importSignature.get(m) === sig) continue;
    importSignature.set(m, sig);
    jsClosureDirty = true;
  }
}

/** Bring the JS worker's extraLibs in line with `wantsJs`. */
function syncJsWorker(): void {
  const models = openJsModels();
  if (jsModelsEdited) {
    jsModelsEdited = false;
    noteJsModelEdits(models);
  }
  if (!jsClosureDirty) return;
  jsClosureDirty = false;
  jsPulled = jsClosure(models);
  for (const [uri, f] of indexed) {
    const want = wantsJs(uri, f.path);
    if (want && !f.js) f.js = monacoTs.javascriptDefaults.addExtraLib(f.content, uri);
    else if (!want && f.js) {
      f.js.dispose();
      f.js = null;
    }
  }
}

/** Installed by the first push; models opened before any index arrived are picked up then. */
function trackJsModels(): void {
  if (jsTracking) return;
  const changed = () => {
    jsClosureDirty = true;
    schedulePush();
  };
  const watch = (m: monacoEditor.ITextModel, announce = true) => {
    m.onDidChangeContent(() => {
      if (m.getLanguageId() !== 'javascript') return;
      jsModelsEdited = true;
      schedulePush();
    });
    m.onWillDispose(() => {
      closing.add(m);
      if (m.getLanguageId() === 'javascript') changed();
    });
    if (announce && m.getLanguageId() === 'javascript') changed();
  };
  jsTracking = [
    monacoEditor.onDidCreateModel((m) => watch(m)),
    monacoEditor.onDidChangeModelLanguage(changed),
  ];
  // The push installing this walks them already.
  jsClosureDirty = true;
  for (const m of monacoEditor.getModels()) watch(m, false);
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
  trackJsModels();
  lastPush = Date.now();
  streamInOutbox = false;
  // One synchronous pass, so monaco's own setTimeout(0) coalescing makes it ONE re-post.
  for (const [uri, { path, content }] of outbox) {
    const prev = indexed.get(uri);
    // An unchanged re-add is a no-op in monaco whose handle removes nothing — keep the old one.
    if (prev?.content === content) continue;
    // Version-stable per file — unlike setExtraLibs, which re-versions every file on every call
    // and would invalidate the whole program per push.
    const ts = monacoTs.typescriptDefaults.addExtraLib(content, uri);
    const js =
      prev?.js || wantsJs(uri, path) ? monacoTs.javascriptDefaults.addExtraLib(content, uri) : null;
    indexedBytes += content.length - (prev?.content.length ?? 0);
    indexed.set(uri, { path, content, ts, js });
    jsClosureDirty = true;
  }
  outbox.clear();
  enforceBudget();
  syncJsWorker();
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
  const containing = containingRoots(path);
  return containing.length ? containing : [...activeRoots];
}

function containingRoots(path: string): string[] {
  const k = folderKey(path);
  return [...loadedByRoot.keys()].filter((r) => k === r || k.startsWith(`${r}/`));
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
    jsPinned.add(uri);
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
 * rest of the project. A new source file saved under an indexed root joins it here too: the
 * fsChanged top-up is debounced, and never comes at all for a folder nothing watches.
 */
export function refreshIndexedFile(path: string, content: string): void {
  const uri = fileUri(path).toString();
  const queued = pending.get(uri);
  if (queued) {
    queued.content = content;
    return;
  }
  if (!indexed.has(uri) && !outbox.has(uri)) {
    const roots = containingRoots(path).filter((r) => isIndexSource(path, r, content));
    if (!roots.length) return;
    for (const r of roots) own(uri, r);
  }
  outbox.set(uri, { path, content });
  schedulePush();
}

/** The host's selection rule (`src/source-index.ts`) and walk exclusions, for one saved file. */
function isIndexSource(path: string, rootKey: string, content: string): boolean {
  const rel = folderKey(path).slice(rootKey.length).replace(/^\/+/, '');
  return (
    !isOversizedForIndex(content.length) &&
    !rel
      .split('/')
      .slice(0, -1)
      .some((dir) => IGNORED_DIRS.has(dir)) &&
    selectIndexCandidates([{ rel, abs: slashPath(path) }]).length === 1
  );
}

export function __resetIndexForTest(): void {
  for (const uri of [...indexed.keys()]) dropIndexed(uri);
  for (const t of [flushTimer, pushTimer]) if (t !== null) clearTimeout(t);
  flushTimer = null;
  pushTimer = null;
  lastPush = Number.NEGATIVE_INFINITY;
  for (const m of [pending, outbox, owners, loadedByRoot, lastActive]) m.clear();
  evicted.clear();
  jsPinned.clear();
  jsPulled = new Set();
  jsClosureDirty = true;
  jsModelsEdited = false;
  for (const d of jsTracking ?? []) d.dispose();
  jsTracking = null;
  activeRoots = new Set();
  budgetLogged = false;
  streamInOutbox = false;
  tracker.reset();
}

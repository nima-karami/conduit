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
import type { TsconfigDTO } from '../src/tsconfig-map';
import { toCompilerOptions } from '../src/tsconfig-map';
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
 * How long to wait for more chunks before pushing to the worker. Each push re-sends the WHOLE
 * extraLib map to the worker (monaco's `_updateExtraLibs`), so flushing per chunk would make
 * the traffic quadratic in project size. The priority wave (seq 0) and the final chunk flush
 * immediately; everything between them coalesces.
 */
const FLUSH_IDLE_MS = 250;

interface IndexedFile {
  path: string;
  content: string;
}

const pending = new Map<string, IndexedFile>();
// What the worker holds, with the handles that take it out again: a rename or delete must remove
// the old path, and only the handle of the latest add can (monaco versions each extraLib).
const indexed = new Map<string, IndexedFile & { handles: { dispose(): void }[] }>();
const tracker = createIndexTracker();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function indexStatus(): IndexProgress {
  return tracker.status();
}

/** True when navigation can honestly say "not found" rather than "still indexing". */
export function isIndexReady(): boolean {
  return tracker.status().done;
}

/**
 * Push files the project index did NOT select — an on-demand module resolution (spec §1).
 *
 * Deliberately does NOT touch the index tracker: `loaded`/`total` describe the PROJECT index,
 * and "N of M" would start lying the moment a package landed. The extraLib push itself is the
 * same one `flush` performs, so there is one place where content reaches the worker.
 */
export function addIndexedFiles(files: readonly IndexedFile[]): void {
  pushExtraLibs(files);
}

function pushExtraLibs(files: Iterable<IndexedFile>): void {
  for (const { path, content } of files) {
    const uri = fileUri(path).toString();
    // An unchanged re-add is a no-op in monaco whose handle removes nothing — keep the old one.
    if (indexed.get(uri)?.content === content) continue;
    // Version-stable per file — unlike setExtraLibs, which re-versions every file on every call
    // and would invalidate the whole program per chunk.
    const handles = [
      monacoTs.typescriptDefaults.addExtraLib(content, uri),
      monacoTs.javascriptDefaults.addExtraLib(content, uri),
    ];
    indexed.set(uri, { path, content, handles });
  }
}

/** Take everything at or under `path` out of the worker and the pending batch; returns both. */
function takeIndexed(
  path: string,
  keepOpen: (path: string) => boolean,
): { pushed: IndexedFile[]; queued: IndexedFile[] } {
  const pushed: IndexedFile[] = [];
  const queued: IndexedFile[] = [];
  for (const [uri, f] of indexed) {
    if (pathBelow(f.path, path) === null) continue;
    for (const h of f.handles) h.dispose();
    indexed.delete(uri);
    pushed.push({ path: f.path, content: f.content });
  }
  for (const [uri, f] of pending) {
    if (pathBelow(f.path, path) === null) continue;
    pending.delete(uri);
    queued.push(f);
  }
  // The worker reads a live model before an extraLib, so a model left on the path (a peeked or
  // closed file) would keep it resolving. An open tab's model is its buffer and stays.
  for (const m of monacoEditor.getModels()) {
    const p = pathForUri(m.uri);
    if (pathBelow(p, path) !== null && !keepOpen(p)) disposeWhenDetached(m);
  }
  return { pushed, queued };
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
  const moved = (f: IndexedFile) => ({
    path: renamedPath(f.path, from, to) ?? f.path,
    content: f.content,
  });
  const { pushed, queued } = takeIndexed(from, keepOpen);
  pushExtraLibs(pushed.map(moved));
  // Still waiting for the flush, which is what counts them as loaded.
  for (const f of queued.map(moved)) pending.set(fileUri(f.path).toString(), f);
}

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.size) return;
  pushExtraLibs(pending.values());
  tracker.markLoaded(pending.size);
  pending.clear();
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
  // A supplemental chunk carries no tsconfig, so treating one as chunk 0 would hand the worker
  // DEFAULT options — which restarts it and throws away the whole index it is topping up.
  if (chunk.seq === 0 && !chunk.supplemental) optionsRoot.noteChunk(chunk.root, chunk.tsconfig);
  tracker.note(chunk.root, {
    total: chunk.total,
    done: chunk.done,
    skipped: chunk.skipped,
    capped: chunk.capped,
    supplemental: chunk.supplemental,
  });
  for (const f of chunk.files) {
    pending.set(fileUri(f.path).toString(), { path: f.path, content: f.content });
  }

  if (flushImmediately(chunk.seq, chunk.done)) {
    flush();
    return;
  }
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_IDLE_MS);
}

/**
 * Refresh one file's indexed content (e.g. after a save), so files that resolve INTO it see
 * the new text. A file open in a tab is a live model and already correct — this is for the
 * rest of the project.
 */
export function refreshIndexedFile(path: string, content: string): void {
  addIndexedFiles([{ path, content }]);
}

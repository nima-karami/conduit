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

import { typescript as monacoTs } from 'monaco-editor';
import type { TsconfigDTO } from '../src/tsconfig-map';
import { toCompilerOptions } from '../src/tsconfig-map';
import { warmLanguageWorker } from './monaco-warmup';
import { fileUri } from './project-index';
import { createIndexTracker, flushImmediately, type IndexProgress } from './ts-index-state';

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

const pending = new Map<string, string>();
const tracker = createIndexTracker();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function indexStatus(): IndexProgress {
  return tracker.status();
}

/** True when navigation can honestly say "not found" rather than "still indexing". */
export function isIndexReady(): boolean {
  return tracker.status().done;
}

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.size) return;
  for (const [uri, content] of pending) {
    // Idempotent for unchanged content, and version-stable — unlike setExtraLibs, which
    // re-versions every file on every call and would invalidate the whole program per chunk.
    monacoTs.typescriptDefaults.addExtraLib(content, uri);
    monacoTs.javascriptDefaults.addExtraLib(content, uri);
  }
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

/**
 * Apply one streamed chunk. Compiler options land BEFORE any content: `setCompilerOptions`
 * fires `onDidChange`, and monaco's WorkerManager disposes the running worker on that event
 * — so applying them mid-stream would throw away everything already pushed. They're also
 * compared before being set, so a re-index with unchanged options doesn't restart the worker.
 */
export function applyProjectFiles(chunk: ProjectFilesChunk): void {
  // A supplemental chunk carries no tsconfig, so treating one as chunk 0 would hand the worker
  // DEFAULT options — which restarts it and throws away the whole index it is topping up.
  if (chunk.seq === 0 && !chunk.supplemental) {
    const options = toCompilerOptions(chunk.tsconfig, (p) => fileUri(p).toString());
    const serialized = JSON.stringify(options);
    if (serialized !== appliedOptions) {
      appliedOptions = serialized;
      monacoTs.typescriptDefaults.setCompilerOptions(options);
      monacoTs.javascriptDefaults.setCompilerOptions(options);
    }
  }
  tracker.note(chunk.root, {
    total: chunk.total,
    done: chunk.done,
    skipped: chunk.skipped,
    capped: chunk.capped,
    supplemental: chunk.supplemental,
  });
  for (const f of chunk.files) pending.set(fileUri(f.path).toString(), f.content);

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
  const uri = fileUri(path).toString();
  monacoTs.typescriptDefaults.addExtraLib(content, uri);
  monacoTs.javascriptDefaults.addExtraLib(content, uri);
}

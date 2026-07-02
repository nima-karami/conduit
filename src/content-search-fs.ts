import * as fs from 'node:fs';
import {
  type AsyncContentSearchDeps,
  type ContentSearchResponse,
  type SearchQuery,
  searchContentAsync,
} from './content-search';

/**
 * Host-side wiring of the pure content-search core against the real filesystem. Kept
 * separate from src/content-search.ts so the core stays node-free (the renderer preview
 * imports the core directly with an in-memory `deps`).
 *
 * Uses the ASYNC core so the walk never blocks the Electron main process: without this a
 * multi-second walk froze IPC, PTY byte-forwarding for every terminal, and all windows.
 * `fs.promises` + a `setImmediate` yield keep the event loop breathing; `stat` gates each
 * file's size before its body is read so a giant file is never slurped into memory. The
 * walker takes forward-slash paths; node's fs accepts those on every platform.
 */
const hostAsyncDeps = (isCancelled?: () => boolean): AsyncContentSearchDeps => ({
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  fileSize: async (p) => (await fs.promises.stat(p)).size,
  readFile: (p) => fs.promises.readFile(p),
  now: () => Date.now(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
  isCancelled,
});

/**
 * Run a project-wide content search off the main thread's critical path. `isCancelled`
 * lets the caller abort an in-flight walk once a newer query supersedes it.
 */
export function searchContentFs(
  root: string,
  query: SearchQuery,
  isCancelled?: () => boolean,
): Promise<ContentSearchResponse> {
  return searchContentAsync(root, query, hostAsyncDeps(isCancelled));
}

import * as fs from 'node:fs';
import {
  type ContentSearchDeps,
  type ContentSearchResponse,
  type SearchQuery,
  searchContent,
} from './content-search';

/**
 * Host-side wiring of the pure content-search core against the real filesystem. Kept
 * separate from src/content-search.ts so the core stays node-free (the renderer preview
 * imports the core directly with an in-memory `deps`). The walker takes forward-slash
 * paths; node's fs accepts those on every platform.
 */
const hostDeps: ContentSearchDeps = {
  readdir: (p) => fs.readdirSync(p, { withFileTypes: true }),
  readFile: (p) => fs.readFileSync(p),
  now: () => Date.now(),
};

export function searchContentFs(root: string, query: SearchQuery): ContentSearchResponse {
  return searchContent(root, query, hostDeps);
}

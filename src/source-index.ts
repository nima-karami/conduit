import type { SearchHit } from './protocol';

// File extensions whose contents back cross-file go-to-definition (the TS/JS worker).
const SRC_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']);

// The TS worker can only resolve a definition into a file it holds a model for, so every
// first-party source file must be indexed. The old 400 cap silently dropped the tail
// (this repo alone has ~400 source files) — the root cause of go-to-def "sometimes" not
// working. The cap is a memory backstop for very large trees; symbols in node_modules stay
// unindexed by design.
export const INDEX_FILE_CAP = 3000;

/**
 * Tool-state directories are not the project's source. A git worktree under `.claude/worktrees`,
 * an agent scratch tree under `.autoloop` — each is a WHOLE SECOND COPY of the checkout, and the
 * TS worker holds a model per copy. That doubles the index (this repo: 450 → 972 files, slow
 * enough to miss a warm-up budget) and, worse, lets go-to-definition land in a stale copy of the
 * file you are already looking at. The walker only skips `.git*`; the index needs the whole class.
 */
const isToolStatePath = (rel: string): boolean =>
  rel
    .split('/')
    .slice(0, -1)
    .some((dir) => dir.startsWith('.'));

/**
 * Choose which walked files to index for go-to-definition: first-party source files only, sorted
 * for deterministic coverage when a huge project exceeds the cap, then capped. Pure so the
 * selection (the part that decides reliability) is unit-tested without spawning Electron.
 */
export function selectIndexHits(hits: SearchHit[], cap = INDEX_FILE_CAP): SearchHit[] {
  return hits
    .filter((h) => SRC_EXT.has(h.rel.split('.').pop()?.toLowerCase() ?? ''))
    .filter((h) => !isToolStatePath(h.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .slice(0, cap);
}

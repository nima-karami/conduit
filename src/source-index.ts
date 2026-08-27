import type { SearchHit } from './protocol';

// File extensions whose contents back cross-file go-to-definition (the TS/JS worker).
const SRC_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']);

// The TS worker can only resolve a definition into a file whose CONTENT it holds, so every
// first-party source file must be indexed. Two caps used to truncate this set and both read
// as "go-to-def sometimes doesn't work": an old 400 cap here, and — until the navigation-parity
// work — `walkFiles`' 4000-entries-of-ANY-type breadth-first cap upstream, which ran out on
// docs/assets before it ever reached deep source directories. The caller now feeds the
// gitignore-aware `git ls-files` index instead, leaving this as a pure memory backstop for
// very large trees. Symbols in node_modules stay unindexed by design.
export const INDEX_FILE_CAP = 5000;

/**
 * Files larger than this are skipped by the index instead of being pushed truncated.
 * Matches `file-service.ts`'s `MAX_BYTES`, which is where the truncation used to happen: a
 * half-file in extraLibs makes the worker confidently report that a symbol past the cut does
 * not exist. See docs/specs/2026-08-21-goto-definition-flows.md contract 5 (row 17).
 */
export const INDEX_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function isOversizedForIndex(bytes: number): boolean {
  return bytes > INDEX_MAX_FILE_BYTES;
}

/**
 * Directories whose subtree is tool state, not the project's source.
 *
 * A git worktree under `.claude/worktrees`, an agent scratch tree under `.autoloop` — each is
 * a WHOLE SECOND COPY of the checkout, and the TS worker holds a model per copy. That doubles
 * the index (this repo: 450 → 972 files, slow enough to miss a warm-up budget) and, worse,
 * lets go-to-definition land in a stale copy of the file you are already looking at.
 *
 * The list is EXPLICIT because "any dot-directory" was too wide: `.storybook`, `.config`,
 * `.github/scripts` and `.vscode` all hold real first-party TypeScript, and dropping them is
 * the row-15 bug. See docs/specs/2026-08-21-goto-definition-flows.md contract 5.
 */
export const TOOL_STATE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.claude',
  '.conduit',
  '.autoloop',
  '.worktrees',
  '.turbo',
  '.next',
  '.nuxt',
  '.vercel',
  '.cache',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
]);

const isToolStatePath = (rel: string): boolean =>
  rel
    .split('/')
    .slice(0, -1)
    .some((dir) => TOOL_STATE_DIRS.has(dir));

/**
 * Every first-party source file worth indexing, deterministically ordered — the set BEFORE the
 * memory cap is applied, so a caller can report how many files the cap left out.
 */
export function selectIndexCandidates(hits: SearchHit[]): SearchHit[] {
  return hits
    .filter((h) => SRC_EXT.has(h.rel.split('.').pop()?.toLowerCase() ?? ''))
    .filter((h) => !isToolStatePath(h.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Choose which walked files to index for go-to-definition: first-party source files only, sorted
 * for deterministic coverage when a huge project exceeds the cap, then capped. Pure so the
 * selection (the part that decides reliability) is unit-tested without spawning Electron.
 */
export function selectIndexHits(hits: SearchHit[], cap = INDEX_FILE_CAP): SearchHit[] {
  return selectIndexCandidates(hits).slice(0, cap);
}

/**
 * The files a top-up index must stream: the current selection minus what this root already
 * sent. Deliberately one-directional — a path that VANISHED keeps its extraLib entry, because
 * removing it is a separate change with its own failure mode (a stale entry still navigates
 * somewhere real; a missing one makes every importer stop resolving mid-edit).
 */
export function newIndexPaths(
  selected: readonly string[],
  alreadySent: ReadonlySet<string>,
): string[] {
  return selected.filter((p) => !alreadySent.has(p));
}

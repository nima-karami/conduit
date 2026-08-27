/**
 * The real-filesystem half of on-demand module resolution: the `FsShim` over `node:fs`, and
 * the bounded directory walk + import closure that decide how much of a resolved module is
 * handed to the language worker.
 *
 * Split from `src/module-resolver.ts` the same way `src/content-search-fs.ts` is split from
 * `src/content-search.ts` — the core stays pure and unit-testable, only this file touches disk.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md §1.
 */

import * as fsSync from 'node:fs';
import { walkFiles } from './file-search';
import { readFile } from './file-service';
import { importClosure } from './import-graph';
import { langFromPath } from './lang';
import type { FsShim } from './module-paths';
import { RESOLVE_EXTENSIONS, type ResolveResult, resolveModule } from './module-resolver';
import { normalizePosix } from './tsconfig-map';

/** How much of a resolved module's own relative closure is indexed with it. Bounded because a
 *  package like `typescript` or `aws-sdk` would otherwise dwarf the whole project index. */
export const CLOSURE_FILE_CAP = 120;
export const CLOSURE_BYTE_CAP = 4 * 1024 * 1024;
/** Matches the index: a file over this is skipped, not truncated (spec §5, row 17). */
export const CLOSURE_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Directory entries the candidate walk may visit. Only ever an upper bound on WORK — the
 *  closure itself is what decides which of them are sent. */
const CLOSURE_WALK_CAP = 4000;

export interface ResolvedModuleFiles {
  entry: string;
  packageDir?: string;
  files: { path: string; content: string; language: string }[];
}

const fwd = (p: string) => normalizePosix(p);

export const hostFsShim: FsShim = {
  readText(path) {
    try {
      return fsSync.readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  isFile(path) {
    try {
      return fsSync.statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isDirectory(path) {
    try {
      return fsSync.statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  realpath(path) {
    try {
      return fwd(fsSync.realpathSync.native(path));
    } catch {
      return path;
    }
  },
};

/** Resolve `specifier` from `fromFile` against the real filesystem. */
function resolveModuleFs(fromFile: string, specifier: string, root: string): ResolveResult {
  return resolveModule({ fromFile: fwd(fromFile), specifier, root: fwd(root) }, hostFsShim);
}

/**
 * Apply the batch bounds to an ordered candidate list, entry first. Unreadable and oversize
 * files drop out rather than failing or truncating the batch — a half-read declaration file
 * makes the worker confidently deny every symbol past the cut (spec row 17).
 */
export function boundFiles(
  ordered: readonly string[],
  read: (p: string) => { content: string; bytes: number } | null,
): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  let bytes = 0;
  for (const path of ordered) {
    if (out.length >= CLOSURE_FILE_CAP) break;
    const hit = read(path);
    if (!hit || hit.bytes > CLOSURE_MAX_FILE_BYTES) continue;
    if (out.length && bytes + hit.bytes > CLOSURE_BYTE_CAP) break;
    bytes += hit.bytes;
    out.push({ path, content: hit.content });
  }
  return out;
}

/**
 * Cache key for one resolution, root-prefixed so `dropResolutionsForRoot` can drop a whole
 * project by prefix. Keyed on the importing DIRECTORY, not the file: every file in one
 * directory resolves a given specifier identically, and a nested `node_modules` still separates
 * because its directory differs.
 */
export function resolveCacheKey(root: string, fromFile: string, specifier: string): string {
  const dir = fwd(fromFile);
  return `${fwd(root)}\0${dir.slice(0, dir.lastIndexOf('/'))}\0${specifier}`;
}

/** Drop every cached resolution belonging to `root`, returning how many went. The `\0` in the
 *  key is what keeps a sibling root that shares a name prefix out of the sweep. */
export function dropResolutionsForRoot(cache: Map<string, unknown>, root: string): number {
  const prefix = `${fwd(root)}\0`;
  let dropped = 0;
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    dropped += 1;
  }
  return dropped;
}

/**
 * How much of the resolve cache is kept. Entries hold whole file CONTENTS, so an unbounded map
 * grows with every package a long session ever navigates into — and a monorepo's worth of
 * `@types` is not small. Eviction is least-recently-USED: `rememberResolution` re-inserts on
 * write and `touchResolution` on read, so the Map's own insertion order IS the LRU order.
 */
export const RESOLVE_CACHE_MAX_ENTRIES = 64;
export const RESOLVE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export type CachedResolution = ResolvedModuleFiles | { failed: string };

/** Bytes one cache entry holds. A remembered FAILURE costs nothing but its key. */
export function resolutionBytes(value: CachedResolution): number {
  if ('failed' in value) return 0;
  let bytes = 0;
  for (const f of value.files) bytes += f.content.length;
  return bytes;
}

/** Read an entry and mark it most-recently-used. */
export function touchResolution<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/** Store an entry, then evict least-recently-used ones until both caps hold. The newest entry
 *  is never evicted — a cache that dropped what it was just asked for would re-walk every time. */
export function rememberResolution(
  cache: Map<string, CachedResolution>,
  key: string,
  value: CachedResolution,
): void {
  cache.delete(key);
  cache.set(key, value);
  let bytes = 0;
  for (const v of cache.values()) bytes += resolutionBytes(v);
  for (const oldest of [...cache.keys()]) {
    if (cache.size <= RESOLVE_CACHE_MAX_ENTRIES && bytes <= RESOLVE_CACHE_MAX_BYTES) break;
    if (cache.size <= 1) break;
    const evicted = cache.get(oldest);
    if (evicted !== undefined) bytes -= resolutionBytes(evicted);
    cache.delete(oldest);
  }
}

const isResolvable = (p: string) => RESOLVE_EXTENSIONS.some((ext) => p.endsWith(ext));

/**
 * Directories the closure walk skips.
 *
 * Deliberately NOT `file-search.ts`'s `SEARCH_IGNORE`, which excludes `dist`/`build`/`out`:
 * that set is right for searching a project and exactly wrong for walking a published package,
 * because `dist/` is where most of npm ships its declarations (zustand, immer, redux, rxjs,
 * and every tsup/rollup build). Using it gave those packages an entry-only closure, so an
 * in-package barrel resolved to nothing and the navigation stopped at `index.d.ts` — silently.
 * A nested `node_modules` still stays out: that is a DIFFERENT package, with its own resolution.
 */
const CLOSURE_IGNORE_DIRS: ReadonlySet<string> = new Set(['node_modules']);

/**
 * Files the closure walk may reach: one bounded directory walk, filtered to source
 * extensions. `importClosure` only ever returns members of the candidate set it is handed
 * (it probes the set, not the disk), so the set has to exist before it runs.
 */
function closureCandidates(entry: string, packageDir: string | undefined): Set<string> {
  const dir = packageDir ?? entry.slice(0, entry.lastIndexOf('/'));
  const walked = walkFiles(dir, CLOSURE_WALK_CAP, undefined, CLOSURE_IGNORE_DIRS)
    .map((h) => fwd(h.abs))
    .filter(isResolvable);
  // The entry is added unconditionally: a package big enough to exhaust the walk cap would
  // otherwise resolve to a file that is then never sent.
  return new Set([entry, ...walked]);
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Resolve, then read the entry plus its bounded relative closure. Async so the walk + reads
 * never block the Electron main thread (same reason `src/content-search-fs.ts` is async).
 */
export async function resolveModuleWithClosure(
  fromFile: string,
  specifier: string,
  root: string,
): Promise<{ ok: true; value: ResolvedModuleFiles } | { ok: false; reason: string }> {
  const resolved = resolveModuleFs(fromFile, specifier, root);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const cache = new Map<string, { content: string; bytes: number } | null>();
  const readCached = async (path: string) => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    await yieldToEventLoop();
    let bytes = 0;
    try {
      bytes = fsSync.statSync(path).size;
    } catch {
      cache.set(path, null);
      return null;
    }
    if (bytes > CLOSURE_MAX_FILE_BYTES) {
      cache.set(path, null);
      return null;
    }
    const dto = await readFile(path);
    const value = dto.binary || dto.error ? null : { content: dto.content, bytes };
    cache.set(path, value);
    return value;
  };

  const candidates = closureCandidates(resolved.entry, resolved.packageDir);
  const ordered = await importClosure(
    [resolved.entry],
    candidates,
    async (p) => (await readCached(p))?.content ?? null,
    CLOSURE_FILE_CAP,
  );
  const files = boundFiles(ordered, (p) => cache.get(p) ?? null).map((f) => ({
    path: f.path,
    content: f.content,
    language: langFromPath(f.path),
  }));
  if (!files.length) return { ok: false, reason: 'unreadable' };
  return {
    ok: true,
    value: {
      entry: resolved.entry,
      ...(resolved.packageDir ? { packageDir: resolved.packageDir } : {}),
      files,
    },
  };
}

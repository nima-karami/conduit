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
export function resolveModuleFs(fromFile: string, specifier: string, root: string): ResolveResult {
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

const isResolvable = (p: string) => RESOLVE_EXTENSIONS.some((ext) => p.endsWith(ext));

/**
 * Files the closure walk may reach: one bounded directory walk, filtered to source
 * extensions. `importClosure` only ever returns members of the candidate set it is handed
 * (it probes the set, not the disk), so the set has to exist before it runs.
 */
function closureCandidates(entry: string, packageDir: string | undefined): Set<string> {
  const dir = packageDir ?? entry.slice(0, entry.lastIndexOf('/'));
  const walked = walkFiles(dir, CLOSURE_WALK_CAP)
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

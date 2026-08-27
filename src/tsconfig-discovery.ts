/**
 * Find the tsconfig that governs one file, and reduce it plus everything it inherits to the
 * `paths`/`baseUrl` a module resolution needs.
 *
 * `electron/main.ts`'s `readProjectTsconfig` reads `<root>/tsconfig.json` and follows a
 * relative-only `extends` — which is why an alias declared in `tsconfig.app.json`, a
 * package-form `extends`, or a referenced project resolves nowhere today. This is the
 * host-side replacement, pure (fs injected) so every config shape is unit-tested against an
 * in-memory tree.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md §1, rows 19/21/22/23.
 */

import { dirOf, type FsShim, nodeModulesDirs, splitPackageSpecifier } from './module-paths';
import {
  joinPosix,
  MAX_EXTENDS_DEPTH,
  mergeCompilerOptions,
  normalizePosix,
  parseTsconfig,
  type RawTsconfig,
} from './tsconfig-map';

/** Config file names probed in each directory, in precedence order. */
export const TSCONFIG_CANDIDATES: readonly string[] = [
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.base.json',
  'jsconfig.json',
];

export interface ResolvedTsconfig {
  /** Pattern → target list, targets already made ABSOLUTE against the declaring config's
   *  baseUrl (or its own dir). Patterns keep their `*`. */
  paths: Record<string, string[]>;
  baseUrl: string | null;
  /** Directory of the config that was found (not of what it extends). */
  configDir: string;
  /** The chain's merged raw compilerOptions, nearest-wins — what the language worker's own
   *  options are built from. References do NOT contribute here: they lend their `paths` to
   *  resolution, they do not redefine the project being compiled (spec row 23). */
  options: Record<string, unknown>;
}

/** Case-insensitive containment, matching `src/path-guard.ts`'s `isInsideRoot` on Windows —
 *  a root and a file can reach this module with different drive-letter casing. */
function isWithin(dir: string, root: string): boolean {
  const d = dir.toLowerCase();
  const r = root.toLowerCase();
  return d === r || d.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * Every standard config present in the nearest directory that has one, in TSCONFIG_CANDIDATES
 * order. Walks up from `fromFile`'s directory to `stopAt` (inclusive); pass the filesystem
 * root to allow a config above the session root (row 33).
 *
 * ALL of them, not just the first: the modern Vite/React layout puts `paths` in
 * `tsconfig.app.json` beside a `tsconfig.json` that only references it, so stopping at the
 * first hit is exactly the row-19 miss.
 *
 * Siblings CAN declare the same pattern. `loadTsconfigForFile` merges them in
 * TSCONFIG_CANDIDATES order with `tsconfig.json` applied LAST, so it wins over
 * `tsconfig.app.json`, which wins over `tsconfig.base.json`, which wins over `jsconfig.json`;
 * a pattern only one of them declares is simply added. That is a resolver heuristic, not
 * TypeScript's own model — `tsc` reads one config per program and would see only the one it
 * was pointed at.
 */
function findNearestTsconfigs(fromFile: string, stopAt: string, fs: FsShim): string[] {
  const root = normalizePosix(stopAt);
  let dir = dirOf(normalizePosix(fromFile));
  for (;;) {
    if (!isWithin(dir, root)) return [];
    const found = TSCONFIG_CANDIDATES.map((name) => joinPosix(dir, name)).filter((p) =>
      fs.isFile(p),
    );
    if (found.length) return found;
    const parent = dirOf(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** The single nearest config — the identity a caller reports, and what the walk-up tests pin. */
export function findNearestTsconfig(fromFile: string, stopAt: string, fs: FsShim): string | null {
  return findNearestTsconfigs(fromFile, stopAt, fs)[0] ?? null;
}

/** Where a config file's `extends` points, as an absolute path — or null when it names a
 *  package this tree doesn't hold. */
function resolveExtends(spec: string, configDir: string, fs: FsShim): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:/.test(spec)) {
    const next = joinPosix(configDir, spec);
    return /\.json$/i.test(next) ? next : `${next}.json`;
  }
  const split = splitPackageSpecifier(spec);
  if (!split) return null;
  // A package `extends` names a config FILE inside the package: bare means its
  // `tsconfig.json`, a subpath means that file (with `.json` implied when it has no
  // extension). Not an `exports` lookup — TypeScript resolves this form by path.
  const rel = split.subpath === '.' ? 'tsconfig.json' : split.subpath.slice(2);
  const file = /\.[a-z]+$/i.test(rel) ? rel : `${rel}.json`;
  for (const nm of nodeModulesDirs(configDir)) {
    const candidate = `${nm}/${split.pkg}/${file}`;
    if (fs.isFile(candidate)) return candidate;
  }
  return null;
}

interface ChainEntry {
  configDir: string;
  raw: RawTsconfig;
}

/** Read one config plus its `extends` chain, outermost-first. Stops on a cycle, a depth cap,
 *  or the first unreadable/unparseable link. */
function readExtendsChain(configPath: string, fs: FsShim, seen: Set<string>): ChainEntry[] {
  const chain: ChainEntry[] = [];
  let file: string | null = normalizePosix(configPath);
  for (let depth = 0; depth < MAX_EXTENDS_DEPTH && file !== null; depth++) {
    const key = file.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    const text = fs.readText(file);
    if (text === null) break;
    const raw = parseTsconfig(text);
    if (!raw) break;
    const configDir = dirOf(file);
    chain.push({ configDir, raw });
    file = typeof raw.extends === 'string' ? resolveExtends(raw.extends, configDir, fs) : null;
  }
  return chain;
}

/** One config's `paths`, made absolute against its own anchor. Absolutised per config rather
 *  than after the merge: an inherited pattern stays anchored where it was declared. */
function absolutePaths(entry: ChainEntry): Record<string, string[]> {
  const options = entry.raw.compilerOptions;
  const raw = options?.paths;
  if (!raw || typeof raw !== 'object') return {};
  const baseUrl = options?.baseUrl;
  const anchor = joinPosix(entry.configDir, typeof baseUrl === 'string' ? baseUrl : '.');
  const out: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue;
    const abs = targets
      .filter((t): t is string => typeof t === 'string')
      .map((t) => joinPosix(anchor, t));
    if (abs.length) out[pattern] = abs;
  }
  return out;
}

/** The first `baseUrl` declared walking outermost-in, absolute against its own config dir. */
function chainBaseUrl(chain: readonly ChainEntry[]): string | null {
  for (const entry of chain) {
    const baseUrl = entry.raw.compilerOptions?.baseUrl;
    if (typeof baseUrl === 'string') return joinPosix(entry.configDir, baseUrl);
  }
  return null;
}

/** Config files a chain's `references` point at, as absolute paths. */
function referencedConfigs(chain: readonly ChainEntry[], fs: FsShim): string[] {
  const out: string[] = [];
  for (const entry of chain) {
    for (const ref of entry.raw.references ?? []) {
      if (typeof ref?.path !== 'string') continue;
      const target = joinPosix(entry.configDir, ref.path);
      out.push(fs.isDirectory(target) ? `${target}/tsconfig.json` : target);
    }
  }
  return out;
}

/**
 * Read one config plus its `extends` chain and its `references`, merged nearest-wins.
 * Returns null when nothing parseable was found.
 */
export function loadTsconfigChain(configPath: string, fs: FsShim): ResolvedTsconfig | null {
  return load(configPath, fs, new Set<string>(), true);
}

/**
 * The `paths`/`baseUrl` governing `fromFile`: every config in its nearest config directory,
 * merged in precedence order (`tsconfig.json` wins). One `seen` set spans them, so a config
 * two of them extend is read once.
 */
export function loadTsconfigForFile(
  fromFile: string,
  stopAt: string,
  fs: FsShim,
): ResolvedTsconfig | null {
  const found = findNearestTsconfigs(fromFile, stopAt, fs);
  if (!found.length) return null;
  const seen = new Set<string>();
  const paths: Record<string, string[]> = {};
  let baseUrl: string | null = null;
  let configDir: string | null = null;
  const options: Record<string, unknown> = {};
  for (const configPath of [...found].reverse()) {
    const cfg = load(configPath, fs, seen, true);
    if (!cfg) continue;
    Object.assign(paths, cfg.paths);
    Object.assign(options, cfg.options);
    if (cfg.baseUrl) baseUrl = cfg.baseUrl;
    configDir = cfg.configDir;
  }
  return configDir === null ? null : { paths, baseUrl, configDir, options };
}

function load(
  configPath: string,
  fs: FsShim,
  seen: Set<string>,
  followReferences: boolean,
): ResolvedTsconfig | null {
  const chain = readExtendsChain(configPath, fs, seen);
  if (!chain.length) return null;

  const paths: Record<string, string[]> = {};
  // References first, so anything the chain itself declares overwrites them: a referenced
  // project contributes aliases, it does not redefine the config the file actually uses.
  // Spec row 23 is explicitly "paths honored", not a full build graph.
  if (followReferences) {
    for (const ref of referencedConfigs(chain, fs)) {
      const loaded = load(ref, fs, seen, false);
      if (loaded) Object.assign(paths, loaded.paths);
    }
  }
  for (const entry of [...chain].reverse()) Object.assign(paths, absolutePaths(entry));

  return {
    paths,
    baseUrl: chainBaseUrl(chain),
    configDir: chain[0].configDir,
    options: mergeCompilerOptions(chain.map((c) => c.raw)),
  };
}

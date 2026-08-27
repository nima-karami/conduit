/**
 * Resolve a module specifier the way Node and TypeScript would — from the file that imports
 * it, not from the session root.
 *
 * This is the fallback the index never had: `node_modules` is not indexed, nothing above the
 * root is either, and a specifier that misses currently resolves to its own import clause. Pure
 * (fs injected) so every package shape is unit-tested against an in-memory tree.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md §1, rows 19/20/25-36.
 */

import { dirOf, type FsShim, nodeModulesDirs, splitPackageSpecifier } from './module-paths';
import { loadTsconfigForFile } from './tsconfig-discovery';
import { joinPosix, normalizePosix } from './tsconfig-map';

export type ResolveFailure =
  | 'not-found' // nothing matched anywhere
  | 'no-entry' // package found, but no usable types/main entry
  | 'unsafe-path' // resolved outside the filesystem into a device/UNC path
  | 'unsupported'; // a specifier form this resolver does not handle (node:, data:, http:)

export interface ResolveRequest {
  /** Absolute forward-slash path of the file that contains the import. */
  fromFile: string;
  specifier: string;
  /** The session root — the boundary for tsconfig discovery only. Resolution itself is NOT
   *  confined to it (spec rows 33/36). */
  root: string;
}

export type ResolveVia = 'relative' | 'alias' | 'baseUrl' | 'node_modules';

export type ResolveResult =
  | { ok: true; entry: string; packageDir?: string; via: ResolveVia }
  | { ok: false; reason: ResolveFailure };

/**
 * Extension probe order. Declarations first — unlike `src/import-graph.ts`, which orders `.ts`
 * first because it is picking which PROJECT file to preload. A navigation into a dependency
 * wants the `.d.ts` that describes it, with the runtime `.js` beside it as the fallback.
 *
 * The `.d.mts`/`.d.cts` (and `.mts`/`.cts`) forms are here because a dual-format build —
 * anything bundled with tsup, and most of the ESM/CJS packages published since — ships its
 * declarations under them. Leaving them out silently emptied such a package's closure.
 */
export const RESOLVE_EXTENSIONS: readonly string[] = [
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

/** `exports` conditions, in the order they are tried. `node` is in the set because a package
 *  routinely nests its declarations under it (`{ node: { types, default }, default }`), and
 *  skipping it lands the navigation on the browser bundle. */
export const EXPORT_CONDITIONS: readonly string[] = [
  'types',
  'node',
  'import',
  'require',
  'default',
];

/** `@types/<pkg>`, with a scoped name mangled the way DefinitelyTyped publishes it. */
export function typesPackageName(pkg: string): string {
  return pkg.startsWith('@') ? `@types/${pkg.slice(1).replace('/', '__')}` : `@types/${pkg}`;
}

/**
 * Reject anything that is not a plain filesystem location. A UNC share or a `\\?\` device path
 * would be read and pushed to the language worker off a navigation the user never vetted, so
 * it fails closed rather than being probed.
 */
export function isSafeResolvedPath(p: string): boolean {
  return !p.startsWith('//') && !p.startsWith('\\\\');
}

/**
 * The file behind a module path, probing extensions and `/index.*` like TS. Mirrors
 * `src/import-graph.ts`'s `resolveRelative`, except it probes the DISK instead of a candidate
 * set — which is the whole reason this module exists.
 */
export function probeFile(base: string, fs: FsShim): string | null {
  const path = normalizePosix(base);
  if (fs.isFile(path)) return path;
  // `./x.js` in ESM-style TypeScript names the emitted file; the declaration beside it is what
  // a navigation wants, so the extension is stripped and re-probed.
  const withoutJsExt = path.replace(/\.(js|jsx|mjs|cjs)$/, '');
  for (const stem of path === withoutJsExt ? [path] : [withoutJsExt, path]) {
    for (const ext of RESOLVE_EXTENSIONS) {
      if (fs.isFile(`${stem}${ext}`)) return `${stem}${ext}`;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      if (fs.isFile(`${stem}/index${ext}`)) return `${stem}/index${ext}`;
    }
  }
  return null;
}

interface WildcardHit {
  key: string;
  tail: string;
}

/** Longest literal prefix wins — TypeScript's own `paths` rule, and `exports`' too. */
function matchWildcard(keys: readonly string[], subject: string): WildcardHit | null {
  let best: WildcardHit | null = null;
  let bestHead = -1;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const head = key.slice(0, star);
    const rest = key.slice(star + 1);
    if (subject.length < head.length + rest.length) continue;
    if (!subject.startsWith(head) || !subject.endsWith(rest)) continue;
    if (head.length <= bestHead) continue;
    bestHead = head.length;
    best = { key, tail: subject.slice(head.length, subject.length - rest.length) };
  }
  return best;
}

/**
 * Walk an `exports` map to the target for `subpath`. A string is the target; an object is
 * either a subpath map (keys starting with `.`) or a conditions map, and the two nest.
 */
export function selectExportsTarget(node: unknown, subpath: string): string | null {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = selectExportsTarget(item, subpath);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const map = node as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.some((k) => k.startsWith('.'))) {
    if (subpath in map) return selectExportsTarget(map[subpath], subpath);
    const wild = matchWildcard(keys, subpath);
    if (!wild) return null;
    const target = selectExportsTarget(map[wild.key], subpath);
    return target ? target.replace(/\*/g, wild.tail) : null;
  }
  for (const condition of EXPORT_CONDITIONS) {
    if (!(condition in map)) continue;
    const hit = selectExportsTarget(map[condition], subpath);
    if (hit) return hit;
  }
  return null;
}

const firstString = (v: unknown): string | null =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;

/**
 * Map a subpath through `typesVersions`. The outer key is a semver range and there is no TS
 * version here to compare it against, so `*` wins and otherwise the first entry is taken —
 * publishers order these newest-first.
 */
export function applyTypesVersions(typesVersions: unknown, subpath: string): string | null {
  if (!typesVersions || typeof typesVersions !== 'object') return null;
  const outer = typesVersions as Record<string, unknown>;
  const rangeKey = '*' in outer ? '*' : Object.keys(outer)[0];
  const inner = rangeKey === undefined ? null : outer[rangeKey];
  if (!inner || typeof inner !== 'object') return null;
  const map = inner as Record<string, unknown>;
  // `typesVersions` patterns are written without a leading `./`.
  const bare = subpath.startsWith('./') ? subpath.slice(2) : subpath;
  if (bare in map) return firstString(map[bare]);
  const wild = matchWildcard(Object.keys(map), bare);
  if (!wild) return null;
  const target = firstString(map[wild.key]);
  return target ? target.replace(/\*/g, wild.tail) : null;
}

interface PackageJson {
  types?: unknown;
  typings?: unknown;
  main?: unknown;
  exports?: unknown;
  typesVersions?: unknown;
}

function readPackageJson(pkgDir: string, fs: FsShim): PackageJson | null {
  const text = fs.readText(`${pkgDir}/package.json`);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * A package's DECLARED types for one subpath.
 *
 * `types`/`typings` describe the package root only — for a subpath TypeScript goes through
 * `exports` and `typesVersions` instead, which is why the two branches differ.
 */
function typesEntry(pkgDir: string, subpath: string, fs: FsShim): string | null {
  const json = readPackageJson(pkgDir, fs);
  if (!json) return null;
  const probe = (rel: string | null) => (rel ? probeFile(joinPosix(pkgDir, rel), fs) : null);
  if (subpath === '.') {
    const declared = str(json.types) ?? str(json.typings);
    // `typesVersions` redirects the declared root types too, not just subpaths — a package
    // shipping `ts4.5/index.d.ts` beside a legacy `index.d.ts` is the common shape.
    const redirected = declared ? applyTypesVersions(json.typesVersions, declared) : null;
    return probe(redirected) ?? probe(declared) ?? probe(selectExportsTarget(json.exports, '.'));
  }
  return (
    probe(selectExportsTarget(json.exports, subpath)) ??
    probe(applyTypesVersions(json.typesVersions, subpath))
  );
}

/** A package's runtime entry for one subpath — the landing spot for an untyped package. */
function runtimeEntry(pkgDir: string, subpath: string, fs: FsShim): string | null {
  if (subpath !== '.') return probeFile(joinPosix(pkgDir, subpath), fs);
  const json = readPackageJson(pkgDir, fs);
  const main = json ? str(json.main) : null;
  return (main ? probeFile(joinPosix(pkgDir, main), fs) : null) ?? probeFile(`${pkgDir}/index`, fs);
}

/** Realpath both halves (rows 31/36) and gate the result. */
function landOn(
  entry: string,
  packageDir: string | null,
  via: ResolveVia,
  fs: FsShim,
): ResolveResult {
  // Guarded BEFORE normalizing: `normalizePosix` collapses the leading `//` that is the only
  // thing distinguishing a UNC share from an ordinary absolute path.
  const raw = fs.realpath(entry).replace(/\\/g, '/');
  if (!isSafeResolvedPath(raw)) return { ok: false, reason: 'unsafe-path' };
  const dir = packageDir === null ? null : normalizePosix(fs.realpath(packageDir));
  return { ok: true, entry: normalizePosix(raw), ...(dir ? { packageDir: dir } : {}), via };
}

/** Substitute a `paths` pattern's captured tail into each of its targets. */
function aliasTargets(paths: Record<string, string[]>, specifier: string): string[] {
  const exact = paths[specifier];
  if (exact) return exact;
  const wild = matchWildcard(Object.keys(paths), specifier);
  return wild ? (paths[wild.key] ?? []).map((t) => t.replace(/\*/g, wild.tail)) : [];
}

const NON_FILE_SCHEME = /^(node|data|http|https|file|bun|blob):/;

/**
 * One `node_modules` directory's answer for a package specifier.
 *
 * Order is TypeScript's: the package's own declared types, then its DefinitelyTyped stub,
 * then its runtime entry — so a typed package is never diverted to `@types`, and an untyped
 * one prefers the stub over the `.js` it would otherwise land in (rows 25/27/28).
 */
function resolveInNodeModules(
  nm: string,
  pkg: string,
  subpath: string,
  fs: FsShim,
): ResolveResult | null {
  const pkgDir = `${nm}/${pkg}`;
  const typesDir = `${nm}/${typesPackageName(pkg)}`;
  const hasPkg = fs.isFile(`${pkgDir}/package.json`);
  const hasTypes = fs.isFile(`${typesDir}/package.json`);
  if (!hasPkg && !hasTypes) return null;
  if (hasPkg) {
    const own = typesEntry(pkgDir, subpath, fs);
    if (own) return landOn(own, pkgDir, 'node_modules', fs);
  }
  if (hasTypes) {
    const stub = typesEntry(typesDir, subpath, fs) ?? runtimeEntry(typesDir, subpath, fs);
    if (stub) return landOn(stub, typesDir, 'node_modules', fs);
  }
  const runtime = hasPkg ? runtimeEntry(pkgDir, subpath, fs) : null;
  // A package directory that exists but yields nothing STOPS the walk — Node does not keep
  // climbing past a real package, and neither may a navigation that reports what it found.
  return runtime ? landOn(runtime, pkgDir, 'node_modules', fs) : { ok: false, reason: 'no-entry' };
}

export function resolveModule(req: ResolveRequest, fs: FsShim): ResolveResult {
  const specifier = req.specifier.trim();
  if (!specifier || NON_FILE_SCHEME.test(specifier)) return { ok: false, reason: 'unsupported' };
  const fromFile = normalizePosix(req.fromFile);
  const fromDir = dirOf(fromFile);

  if (specifier.startsWith('.')) {
    const hit = probeFile(joinPosix(fromDir, specifier), fs);
    return hit ? landOn(hit, null, 'relative', fs) : { ok: false, reason: 'not-found' };
  }

  const config = loadTsconfigForFile(fromFile, req.root, fs);
  if (config) {
    for (const target of aliasTargets(config.paths, specifier)) {
      const hit = probeFile(target, fs);
      if (hit) return landOn(hit, null, 'alias', fs);
    }
    if (config.baseUrl) {
      const hit = probeFile(joinPosix(config.baseUrl, specifier), fs);
      if (hit) return landOn(hit, null, 'baseUrl', fs);
    }
  }

  const split = splitPackageSpecifier(specifier);
  if (!split) return { ok: false, reason: 'not-found' };
  for (const nm of nodeModulesDirs(fromDir)) {
    const hit = resolveInNodeModules(nm, split.pkg, split.subpath, fs);
    if (hit) return hit;
  }
  return { ok: false, reason: 'not-found' };
}

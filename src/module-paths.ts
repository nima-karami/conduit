/**
 * The path primitives module resolution and tsconfig discovery both need, and the injected
 * filesystem they run against.
 *
 * Separate from `src/tsconfig-discovery.ts` and `src/module-resolver.ts` so those two can
 * import it without importing each other: config discovery has to resolve a package-form
 * `extends` through `node_modules`, and the resolver has to consult config discovery for
 * aliases. Owning the shared half here is what keeps that from being an import cycle.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md §1.
 */

import { normalizePosix } from './tsconfig-map';

/**
 * The filesystem, narrowed to what resolution needs. Injected so both consumers stay pure and
 * every package shape is unit-testable against an in-memory tree — the same split
 * `src/content-search.ts` uses. Every path is FORWARD-SLASH absolute.
 */
export interface FsShim {
  /** File text, or null when it doesn't exist / can't be read. */
  readText(path: string): string | null;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  /** Canonical path with symlinks/junctions resolved; returns `path` unchanged on failure. */
  realpath(path: string): string;
}

/** The directory part of an absolute forward-slash path; a root is its own parent. */
export function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  if (at < 0) return path;
  return at === 0 ? '/' : path.slice(0, at);
}

/** Append one segment to a directory without doubling the separator at a POSIX root. */
const under = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/**
 * Every `node_modules` directory Node would consult for a bare specifier imported from
 * `fromDir`, nearest first — which is what makes a pnpm-shaped or non-hoisted install resolve
 * to the copy the importing file actually sees (spec row 36).
 */
export function nodeModulesDirs(fromDir: string): string[] {
  const out: string[] = [];
  let dir = normalizePosix(fromDir);
  for (;;) {
    if (!dir.endsWith('/node_modules')) out.push(under(dir, 'node_modules'));
    const parent = dirOf(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Split a bare specifier into its package name and the subpath within it. Returns null for
 * anything that isn't a package reference (relative paths, absolute paths, URLs).
 *
 * The subpath is spelled the way an `exports` map does (`'.'` for the package root), so it can
 * be matched against one without a second normalisation step.
 */
export function splitPackageSpecifier(spec: string): { pkg: string; subpath: string } | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:/.test(spec)) return null;
  const parts = spec.split('/').filter(Boolean);
  if (!parts.length) return null;
  const take = parts[0].startsWith('@') ? 2 : 1;
  if (parts.length < take) return null;
  const pkg = parts.slice(0, take).join('/');
  const rest = parts.slice(take);
  return { pkg, subpath: rest.length ? `./${rest.join('/')}` : '.' };
}

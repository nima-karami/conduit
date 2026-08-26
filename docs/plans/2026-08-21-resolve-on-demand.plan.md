# Resolve Anything, Index On Demand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A navigation that misses because the target simply isn't in the index stops being a
dead end. The host resolves the module the way Node/TypeScript would — from the *importing
file*, not from the session root — pushes the entry file and its bounded relative closure to the
language worker as extraLibs, and the navigation is retried once. `zod`, `lodash` via
`@types`, `date-fns/format`, a workspace sibling behind a junction, `../shared/x` above the
root, an alias declared in `tsconfig.app.json`, a package-form `extends` — all become
reachable.

**Architecture:** Two pure host modules with an injected fs shim, so every package shape is
unit-tested against an in-memory tree instead of a fixture install: `src/tsconfig-discovery.ts`
(nearest-config walk-up, `extends` chain incl. the package form, `references` contributing their
`paths`) and `src/module-resolver.ts` (relative → alias/`baseUrl` → walk-up `node_modules` with
`exports` conditions, `typesVersions`, `@types`, `main`, and `realpath`). The real-filesystem
wiring plus the bounded closure walk live in `src/module-resolver-fs.ts` — the same
core/`-fs` split `src/content-search.ts` / `src/content-search-fs.ts` already uses. One new IPC
pair (`resolveModule` / `resolveModuleResult`) carries the files; the renderer feeds them
through the SAME extraLib path project files use, then Plan A's `onUnresolved` hook retries the
navigation. Resolutions are cached per root in `electron/main.ts` beside the existing
`fileIndexCache`, and dropped when that root changes on disk or is re-indexed.

**Tech Stack:** TypeScript, Electron main process, monaco's TS worker over extraLibs, vitest
(`test/unit/`), Playwright-Electron e2e (`test/e2e/harness.mjs`).

**Spec:** `docs/specs/2026-08-21-goto-definition-flows.md` — contract §1 and §2; flow rows 6, 7,
19, 22–36.

**Depends on:**
- `docs/plans/2026-08-21-nav-outcome.plan.md` (Plan A) — this plan registers the
  `setUnresolvedResolver` hook Plan A defines. Without Plan A there is nothing to hook.
- The fixture matrix task (`test/e2e/fixtures/goto/build-fixture.mjs` +
  `test/e2e/goto-matrix*.e2e.mjs`) for Task 6 only.

## Global Constraints

- `npm run verify` must stay fully green; never weaken/narrow/disable any gate.
- Comments: WHY only; link the spec (`// see docs/specs/2026-08-21-goto-definition-flows.md §1`),
  never restate it. Hard repo rule (CLAUDE.md).
- Two tsconfigs (host + webview): `npm run typecheck` runs both. `src/tsconfig-discovery.ts` and
  `src/module-resolver.ts` must import **no node builtins** — they take an injected shim, exactly
  like `src/content-search.ts`. Only `src/module-resolver-fs.ts` may `import * as fs from 'node:fs'`.
- Biome: `lint/suspicious/noControlCharactersInRegex` is an error — the cache key's `\0` separator
  is a string join, never a regex.
- E2E runs strictly serially; a failure on a loaded machine must be re-run ALONE before being
  believed (CLAUDE.md).
- All commands run inside the task worktree, never the main checkout; never place the worktree
  inside the repo (`biome check .` breaks on a nested root config).
- `fallow:check` gates on dead code and unlisted deps — everything exported here must have a
  caller or a test.

## Verified facts this plan is built on

Read before editing; each was checked against the code on 2026-08-21.

- `electron/main.ts` `readProjectTsconfig` reads **only** `<root>/tsconfig.json` and follows a
  **relative-only** `extends` (`if (typeof cfg.extends !== 'string' || !cfg.extends.startsWith('.')) break;`),
  capped at `MAX_EXTENDS_DEPTH` (= 3, `src/tsconfig-map.ts`). That is rows 19/22/23 failing by
  construction.
- `src/source-index.ts` `selectIndexHits` filters to `SRC_EXT`, drops any path with a
  dot-directory ancestor, sorts, and caps at `INDEX_FILE_CAP = 5000`. `node_modules` never enters
  the candidate set — `projectFileIndexMeta` builds it from `git ls-files` (which excludes it) or
  a `walkFiles` walk whose `SEARCH_IGNORE` excludes it.
- `src/import-graph.ts` `importClosure(seeds, candidates, read, cap)` only ever returns paths that
  are **already in `candidates`** (`resolveRelative` probes the set, not the disk). Reusing it for
  a package therefore requires building the package's candidate set first — a bounded directory
  walk. That is Task 3, and it is why `-fs` exists.
- `readFile` (`src/file-service.ts`) truncates at `MAX_BYTES = 2 MiB` and flags `truncated`; it
  is not root-confined (the `readFile` IPC case grants a write-grant on success, but does not
  restrict the read).
- **`fsChanged` carries only `{ root }` — no changed path — and `shouldIgnoreWatchPath`
  (`src/watch-filter.ts`) drops every event whose path contains a `node_modules` segment before
  the debounce ever fires.** A per-path or per-package cache invalidation is therefore not
  implementable against today's watcher, and an `npm install` produces no `fsChanged` at all. See
  Task 5 for what this plan does instead.
- `applyProjectFiles` (`webview/ts-project.ts`) sets compiler options **only on `chunk.seq === 0`**
  and compares the serialized options before setting them, because `setCompilerOptions` disposes
  the running worker. Supplemental files must never travel as a `seq === 0` chunk.
- Monaco's `addExtraLib(content, uri)` is idempotent for unchanged content and version-stable;
  `setExtraLibs` re-versions everything. Only `addExtraLib` is used here (CLAUDE.md).

---

### Task 1: `src/tsconfig-discovery.ts` — nearest config, real `extends`, `references`

**Files:**
- Create: `src/tsconfig-discovery.ts`
- Test: `test/unit/tsconfig-discovery.test.ts` (new; style-match `test/unit/tsconfig-map.test.ts`)

**Interfaces** (later tasks rely on these exact names):

```ts
/** The filesystem, narrowed to what resolution needs. Injected so the core is pure — same
 *  shape as src/content-search.ts's deps. Every path is FORWARD-SLASH absolute. */
export interface FsShim {
  /** File text, or null when it doesn't exist / can't be read. */
  readText(path: string): string | null;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  /** Canonical path with symlinks/junctions resolved; returns `path` unchanged on failure. */
  realpath(path: string): string;
}

/** Config file names probed in each directory, in precedence order. */
export const TSCONFIG_CANDIDATES: readonly string[]; // tsconfig.json, tsconfig.app.json, tsconfig.base.json, jsconfig.json

export interface ResolvedTsconfig {
  /** Pattern → target list, targets already made ABSOLUTE against the declaring config's
   *  baseUrl (or its own dir). Patterns keep their `*`. */
  paths: Record<string, string[]>;
  baseUrl: string | null;
  /** Directory of the config that was found (not of what it extends). */
  configDir: string;
}

/** Walk up from `fromFile`'s directory to `stopAt` (inclusive) probing TSCONFIG_CANDIDATES.
 *  `stopAt` bounds the walk for a normal project; pass the filesystem root to allow a config
 *  above the session root (row 33). Returns the config's absolute path, or null. */
export function findNearestTsconfig(fromFile: string, stopAt: string, fs: FsShim): string | null;

/** Read one config plus its `extends` chain and its `references`, merged nearest-wins.
 *  Returns null when nothing parseable was found. */
export function loadTsconfigChain(configPath: string, fs: FsShim): ResolvedTsconfig | null;
```

- [ ] **Step 1a: Write the shared in-memory tree helper** — `test/unit/mem-fs.ts`

Vitest collects `test/unit/**/*.test.ts` only (`vitest.config.ts`), so a bare `.ts` helper beside
the tests is not itself collected. Task 2's tests import the same helper — one copy, not two.

```ts
import type { FsShim } from '../../src/tsconfig-discovery';

/** In-memory tree. Keys are forward-slash absolute paths; a value of `null` marks a directory. */
export function memFs(tree: Record<string, string | null>): FsShim {
  const dirs = new Set<string>();
  for (const p of Object.keys(tree)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (tree[p] === null) dirs.add(p);
  }
  return {
    readText: (p) => (typeof tree[p] === 'string' ? (tree[p] as string) : null),
    isFile: (p) => typeof tree[p] === 'string',
    isDirectory: (p) => dirs.has(p),
    realpath: (p) => p,
  };
}
```

- [ ] **Step 1b: Write the failing tests** — `test/unit/tsconfig-discovery.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  findNearestTsconfig,
  loadTsconfigChain,
  TSCONFIG_CANDIDATES,
} from '../../src/tsconfig-discovery';
import { memFs } from './mem-fs';

const J = (o: unknown) => JSON.stringify(o);

describe('findNearestTsconfig', () => {
  it('prefers the closest config to the importing file', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': J({}),
      'g:/p/apps/web/tsconfig.json': J({}),
      'g:/p/apps/web/src/a.ts': '',
    });
    expect(findNearestTsconfig('g:/p/apps/web/src/a.ts', 'g:/p', fs)).toBe(
      'g:/p/apps/web/tsconfig.json',
    );
  });

  it('honours the candidate precedence order within one directory — row 19', () => {
    const fs = memFs({
      'g:/p/tsconfig.app.json': J({}),
      'g:/p/jsconfig.json': J({}),
      'g:/p/src/a.ts': '',
    });
    expect(TSCONFIG_CANDIDATES).toEqual([
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.base.json',
      'jsconfig.json',
    ]);
    expect(findNearestTsconfig('g:/p/src/a.ts', 'g:/p', fs)).toBe('g:/p/tsconfig.app.json');
  });

  it('stops at the boundary and reports nothing rather than climbing to the drive', () => {
    const fs = memFs({ 'g:/tsconfig.json': J({}), 'g:/p/src/a.ts': '' });
    expect(findNearestTsconfig('g:/p/src/a.ts', 'g:/p', fs)).toBeNull();
  });
});

describe('loadTsconfigChain', () => {
  it('makes paths absolute against baseUrl', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': J({ compilerOptions: { baseUrl: './src', paths: { '@/*': ['lib/*'] } } }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.baseUrl).toBe('g:/p/src');
    expect(cfg?.paths['@/*']).toEqual(['g:/p/src/lib/*']);
  });

  it('anchors paths on the config dir when baseUrl is absent (TS ≥ 4.4)', () => {
    const fs = memFs({ 'g:/p/tsconfig.json': J({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }) });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['~/*']).toEqual(['g:/p/src/*']);
  });

  it('follows a relative extends, nearest-wins — row 21', () => {
    const fs = memFs({
      'g:/p/tsconfig.base.json': J({ compilerOptions: { baseUrl: '.', paths: { '@base/*': ['b/*'] } } }),
      'g:/p/tsconfig.json': J({ extends: './tsconfig.base.json', compilerOptions: { paths: { '@app/*': ['a/*'] } } }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(Object.keys(cfg?.paths ?? {}).sort()).toEqual(['@app/*', '@base/*']);
  });

  it('resolves a PACKAGE-form extends through node_modules — row 22', () => {
    const fs = memFs({
      'g:/p/node_modules/@tsconfig/node20/tsconfig.json': J({
        compilerOptions: { target: 'es2022', paths: { '#pkg/*': ['./x/*'] } },
      }),
      'g:/p/tsconfig.json': J({ extends: '@tsconfig/node20' }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.paths['#pkg/*']).toEqual(['g:/p/node_modules/@tsconfig/node20/x/*']);
  });

  it('resolves a package extends that names a file explicitly', () => {
    const fs = memFs({
      'g:/p/node_modules/shared/tsconfig.strict.json': J({ compilerOptions: { paths: { 's/*': ['./s/*'] } } }),
      'g:/p/tsconfig.json': J({ extends: 'shared/tsconfig.strict.json' }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['s/*']).toEqual([
      'g:/p/node_modules/shared/s/*',
    ]);
  });

  it('lets project references contribute their paths, at lower precedence — row 23', () => {
    const fs = memFs({
      'g:/p/packages/ui/tsconfig.json': J({ compilerOptions: { paths: { '@ui/*': ['./src/*'] } } }),
      'g:/p/tsconfig.json': J({
        references: [{ path: './packages/ui' }],
        compilerOptions: { paths: { '@app/*': ['./src/*'] } },
      }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.paths['@ui/*']).toEqual(['g:/p/packages/ui/src/*']);
    expect(cfg?.paths['@app/*']).toEqual(['g:/p/src/*']);
  });

  it("a reference cannot override the nearest config's own alias", () => {
    const fs = memFs({
      'g:/p/packages/ui/tsconfig.json': J({ compilerOptions: { paths: { '@x/*': ['./ui/*'] } } }),
      'g:/p/tsconfig.json': J({
        references: [{ path: './packages/ui' }],
        compilerOptions: { paths: { '@x/*': ['./mine/*'] } },
      }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['@x/*']).toEqual(['g:/p/mine/*']);
  });

  it('survives a circular extends and a malformed config without hanging or throwing', () => {
    const fs = memFs({
      'g:/p/a.json': J({ extends: './b.json' }),
      'g:/p/b.json': J({ extends: './a.json' }),
      'g:/p/bad.json': '{ this is not json',
    });
    expect(() => loadTsconfigChain('g:/p/a.json', fs)).not.toThrow();
    expect(loadTsconfigChain('g:/p/bad.json', fs)).toBeNull();
  });

  it('tolerates JSONC (comments + trailing commas)', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': '{\n // c\n "compilerOptions": { "paths": { "a/*": ["./a/*"] }, },\n}',
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['a/*']).toEqual(['g:/p/a/*']);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/tsconfig-discovery.test.ts`.
  Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/tsconfig-discovery.ts`**

Reuse, do not re-implement: `parseTsconfig`, `stripJsonc`, `joinPosix`, `normalizePosix`,
`MAX_EXTENDS_DEPTH` from `src/tsconfig-map.ts`. `RawTsconfig` needs one more optional field —
add `references?: { path?: string }[];` to it there (it is already the shared raw shape).

`findNearestTsconfig`: normalize both paths, walk from `dirname(fromFile)` upward while the
directory is inside `stopAt` (use the existing `isInsideRoot` semantics — but this module is
pure, so do the prefix check locally on normalized paths); at each level probe
`TSCONFIG_CANDIDATES` in order via `fs.isFile`. Return the first hit.

`loadTsconfigChain`: iterate a stack with a `seen: Set<string>` (kills the circular case) and a
`MAX_EXTENDS_DEPTH` cap. For each config:
- parse with `parseTsconfig`; a null parse at the ROOT config returns null, deeper down just
  stops the chain (matches `readProjectTsconfig`'s existing forgiveness).
- record `{ configDir, compilerOptions }`.
- `extends` starting with `.` or `/` or a drive → `joinPosix(configDir, extends)`, appending
  `.json` when absent (same rule `readProjectTsconfig` uses).
- otherwise it is a PACKAGE form: split into `pkg` (`@scope/name` or `name`) and an optional
  subpath; walk `node_modules` up from `configDir` (share the helper with Task 2 — export
  `nodeModulesDirs(fromDir: string): string[]` from `src/module-resolver.ts` and import it here,
  or the reverse; pick one owner and have the other import it, never two copies). Candidate file =
  `<pkgDir>/<subpath || 'tsconfig.json'>`, appending `.json` when the subpath has no extension.

Merge order: options merge nearest-wins via the existing `mergeCompilerOptions` (it already
reverses the chain). `paths` need per-entry absolutisation **at the declaring config's own
anchor**, so do NOT merge raw `paths` and absolutise once — absolutise each config's `paths`
against `joinPosix(thatConfigDir, thatConfig.baseUrl ?? '.')` as it is read, then merge the
already-absolute maps nearest-wins.

`references`: after the extends chain, for each `references[].path` resolve
`joinPosix(configDir, path)`; if it is a directory, append `/tsconfig.json`. Load each with a
recursive `loadTsconfigChain` (guarded by the same `seen` set and a depth of 1 — references of
references are out of scope per spec row 23) and merge their absolute `paths` **underneath**
everything the nearest chain declared.

`baseUrl` on the result = the nearest config's own absolute baseUrl, or null.

- [ ] **Step 4: Run** — `npx vitest run test/unit/tsconfig-discovery.test.ts test/unit/tsconfig-map.test.ts`.
  Expected: PASS (the `tsconfig-map` suite is the regression net for the shared helpers).
- [ ] **Step 5: Commit** — `git commit -m "feat(nav): nearest-tsconfig discovery with package extends and project references"`

### Task 2: `src/module-resolver.ts` — Node/TS resolution from the importing file

**Files:**
- Create: `src/module-resolver.ts`
- Test: `test/unit/module-resolver.test.ts` (new)

**Interfaces:**

```ts
import type { FsShim } from './tsconfig-discovery';

export type ResolveFailure =
  | 'not-found'          // nothing matched anywhere
  | 'no-entry'           // package found, but no usable types/main entry
  | 'unsafe-path'        // resolved outside the filesystem into a device/UNC path
  | 'unsupported';       // a specifier form this resolver does not handle (node:, data:, http:)

export interface ResolveRequest {
  /** Absolute forward-slash path of the file that contains the import. */
  fromFile: string;
  specifier: string;
  /** The session root — the boundary for tsconfig discovery only. Resolution itself is NOT
   *  confined to it (spec rows 33/36). */
  root: string;
}

export type ResolveResult =
  | { ok: true; entry: string; packageDir?: string; via: 'relative' | 'alias' | 'baseUrl' | 'node_modules' }
  | { ok: false; reason: ResolveFailure };

export function resolveModule(req: ResolveRequest, fs: FsShim): ResolveResult;

// Exported for tests and for Task 1's package-extends resolution:
export function nodeModulesDirs(fromDir: string): string[];
export function splitPackageSpecifier(spec: string): { pkg: string; subpath: string } | null;
export function typesPackageName(pkg: string): string;
export function probeFile(base: string, fs: FsShim): string | null;
export function selectExportsTarget(node: unknown, subpath: string): string | null;
export function applyTypesVersions(
  typesVersions: unknown,
  subpath: string,
): string | null;
export function isSafeResolvedPath(p: string): boolean;
/** Extension probe order — mirrors src/import-graph.ts's EXT_CANDIDATES, types first. */
export const RESOLVE_EXTENSIONS: readonly string[];
/** `exports` conditions, in the order they are tried. */
export const EXPORT_CONDITIONS: readonly string[]; // 'types', 'import', 'require', 'default'
```

- [ ] **Step 1: Write the failing tests** — `test/unit/module-resolver.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { memFs } from './mem-fs';
import {
  isSafeResolvedPath,
  nodeModulesDirs,
  resolveModule,
  splitPackageSpecifier,
  typesPackageName,
} from '../../src/module-resolver';

const J = (o: unknown) => JSON.stringify(o);
const at = (tree: Record<string, string | null>, specifier: string, fromFile = 'g:/p/src/a.ts') =>
  resolveModule({ fromFile, specifier, root: 'g:/p' }, memFs(tree));

describe('helpers', () => {
  it('splits scoped and subpath specifiers', () => {
    expect(splitPackageSpecifier('zod')).toEqual({ pkg: 'zod', subpath: '.' });
    expect(splitPackageSpecifier('date-fns/format')).toEqual({ pkg: 'date-fns', subpath: './format' });
    expect(splitPackageSpecifier('@scope/pkg')).toEqual({ pkg: '@scope/pkg', subpath: '.' });
    expect(splitPackageSpecifier('@scope/pkg/sub/deep')).toEqual({
      pkg: '@scope/pkg',
      subpath: './sub/deep',
    });
    expect(splitPackageSpecifier('./relative')).toBeNull();
  });

  it('maps a package to its @types name — row 27', () => {
    expect(typesPackageName('lodash')).toBe('@types/lodash');
    expect(typesPackageName('@scope/pkg')).toBe('@types/scope__pkg');
  });

  it('lists node_modules dirs from the importing file upward — row 36', () => {
    expect(nodeModulesDirs('g:/p/apps/web/src')).toEqual([
      'g:/p/apps/web/src/node_modules',
      'g:/p/apps/web/node_modules',
      'g:/p/apps/node_modules',
      'g:/p/node_modules',
      'g:/node_modules',
    ]);
  });

  it('rejects device and UNC paths', () => {
    expect(isSafeResolvedPath('g:/p/a.ts')).toBe(true);
    expect(isSafeResolvedPath('/home/u/a.ts')).toBe(true);
    expect(isSafeResolvedPath('//server/share/a.ts')).toBe(false);
    expect(isSafeResolvedPath('\\\\?\\C:\\a.ts')).toBe(false);
  });
});

describe('relative specifiers', () => {
  it('probes extensions and index like TS — rows 2/3/5', () => {
    const tree = { 'g:/p/src/b.ts': '', 'g:/p/src/c/index.tsx': '', 'g:/p/src/a.ts': '' };
    expect(at(tree, './b')).toMatchObject({ ok: true, entry: 'g:/p/src/b.ts', via: 'relative' });
    expect(at(tree, './c')).toMatchObject({ ok: true, entry: 'g:/p/src/c/index.tsx' });
  });

  it('maps an ESM .js specifier back to its .ts source', () => {
    expect(at({ 'g:/p/src/b.ts': '', 'g:/p/src/a.ts': '' }, './b.js')).toMatchObject({
      entry: 'g:/p/src/b.ts',
    });
  });

  it('resolves ABOVE the session root — row 33', () => {
    const r = at({ 'g:/shared/x.ts': '', 'g:/p/src/a.ts': '' }, '../../../shared/x');
    expect(r).toMatchObject({ ok: true, entry: 'g:/shared/x.ts' });
  });

  it('reports not-found instead of guessing', () => {
    expect(at({ 'g:/p/src/a.ts': '' }, './nope')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('tsconfig aliases', () => {
  it('resolves an alias declared in tsconfig.app.json — rows 19/32', () => {
    const r = at(
      {
        'g:/p/tsconfig.app.json': J({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
        'g:/p/src/lib/deep.ts': '',
        'g:/p/src/a.ts': '',
      },
      '@/lib/deep',
    );
    expect(r).toMatchObject({ ok: true, entry: 'g:/p/src/lib/deep.ts', via: 'alias' });
  });

  it('resolves a non-relative import through baseUrl — row 20', () => {
    const r = at(
      {
        'g:/p/tsconfig.json': J({ compilerOptions: { baseUrl: './src' } }),
        'g:/p/src/util/x.ts': '',
        'g:/p/src/a.ts': '',
      },
      'util/x',
    );
    expect(r).toMatchObject({ ok: true, entry: 'g:/p/src/util/x.ts', via: 'baseUrl' });
  });

  it('prefers the nearest package-level config over the root one — rows 19/24/32', () => {
    const r = at(
      {
        'g:/p/tsconfig.json': J({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['wrong/*'] } } }),
        'g:/p/apps/web/tsconfig.json': J({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
        'g:/p/apps/web/src/ok.ts': '',
        'g:/p/apps/web/src/a.ts': '',
        'g:/p/wrong/ok.ts': '',
      },
      '@/ok',
      'g:/p/apps/web/src/a.ts',
    );
    expect(r).toMatchObject({ entry: 'g:/p/apps/web/src/ok.ts' });
  });
});

describe('bare specifiers', () => {
  const pkg = (dir: string, json: unknown, files: Record<string, string> = {}) => ({
    [`${dir}/package.json`]: J(json),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v])),
  });

  it('lands on a types entry — row 25', () => {
    const r = at(
      { 'g:/p/src/a.ts': '', ...pkg('g:/p/node_modules/zod', { types: './index.d.ts' }, { 'index.d.ts': '' }) },
      'zod',
    );
    expect(r).toMatchObject({
      ok: true,
      entry: 'g:/p/node_modules/zod/index.d.ts',
      packageDir: 'g:/p/node_modules/zod',
      via: 'node_modules',
    });
  });

  it('accepts the legacy `typings` key', () => {
    const r = at(
      { 'g:/p/src/a.ts': '', ...pkg('g:/p/node_modules/old', { typings: 'types/main.d.ts' }, { 'types/main.d.ts': '' }) },
      'old',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/old/types/main.d.ts' });
  });

  it('honours an exports map with a types condition — row 26', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/mod',
          { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } },
          { 'dist/index.d.ts': '', 'dist/index.js': '' },
        ),
      },
      'mod',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/mod/dist/index.d.ts' });
  });

  it('handles the string form and a nested condition object', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/mod',
          { exports: { '.': { node: { types: './n.d.ts', default: './n.js' }, default: './d.js' } } },
          { 'n.d.ts': '', 'n.js': '', 'd.js': '' },
        ),
      },
      'mod',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/mod/n.d.ts' });
  });

  it('resolves a subpath through exports — row 29', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/date-fns',
          { exports: { './format': { types: './format/index.d.ts' } } },
          { 'format/index.d.ts': '' },
        ),
      },
      'date-fns/format',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/date-fns/format/index.d.ts' });
  });

  it('resolves a wildcard exports subpath', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/w', { exports: { './*': './lib/*.d.ts' } }, { 'lib/thing.d.ts': '' }),
      },
      'w/thing',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/w/lib/thing.d.ts' });
  });

  it('applies typesVersions — row 26', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/tv',
          { types: './index.d.ts', typesVersions: { '*': { '*': ['ts4.5/*'] } } },
          { 'ts4.5/index.d.ts': '', 'index.d.ts': '' },
        ),
      },
      'tv',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/tv/ts4.5/index.d.ts' });
  });

  it('falls back to @types — row 27', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/lodash', { main: './index.js' }, { 'index.js': '' }),
        ...pkg('g:/p/node_modules/@types/lodash', { types: './index.d.ts' }, { 'index.d.ts': '' }),
      },
      'lodash',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/@types/lodash/index.d.ts' });
  });

  it('maps a scoped package to its mangled @types name', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/@scope/pkg', { main: './i.js' }, { 'i.js': '' }),
        ...pkg('g:/p/node_modules/@types/scope__pkg', { types: './i.d.ts' }, { 'i.d.ts': '' }),
      },
      '@scope/pkg',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/@types/scope__pkg/i.d.ts' });
  });

  it('lands on the JS entry for an untyped package — row 28', () => {
    const r = at(
      { 'g:/p/src/a.ts': '', ...pkg('g:/p/node_modules/plain', { main: 'lib/main.js' }, { 'lib/main.js': '' }) },
      'plain',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/plain/lib/main.js' });
  });

  it('falls back to index.js with no main at all', () => {
    const r = at(
      { 'g:/p/src/a.ts': '', ...pkg('g:/p/node_modules/bare', {}, { 'index.js': '' }) },
      'bare',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/bare/index.js' });
  });

  it('prefers the NEAREST node_modules — pnpm / nested hoisting, row 36', () => {
    const r = at(
      {
        'g:/p/apps/web/src/a.ts': '',
        ...pkg('g:/p/node_modules/dep', { types: './root.d.ts' }, { 'root.d.ts': '' }),
        ...pkg('g:/p/apps/web/node_modules/dep', { types: './near.d.ts' }, { 'near.d.ts': '' }),
      },
      'dep',
      'g:/p/apps/web/src/a.ts',
    );
    expect(r).toMatchObject({ entry: 'g:/p/apps/web/node_modules/dep/near.d.ts' });
  });

  it('realpaths a junction/symlinked workspace package — row 31', () => {
    const tree = {
      'g:/p/src/a.ts': '',
      'g:/p/node_modules/@ws/ui/package.json': J({ types: './src/index.ts' }),
      'g:/p/node_modules/@ws/ui/src/index.ts': '',
    };
    const base = memFs(tree);
    const fs = {
      ...base,
      realpath: (p: string) => p.replace('g:/p/node_modules/@ws/ui', 'g:/p/packages/ui'),
    };
    const r = resolveModule({ fromFile: 'g:/p/src/a.ts', specifier: '@ws/ui', root: 'g:/p' }, fs);
    expect(r).toMatchObject({
      ok: true,
      entry: 'g:/p/packages/ui/src/index.ts',
      packageDir: 'g:/p/packages/ui',
    });
  });

  it('reports no-entry for a package with nothing usable', () => {
    const r = at({ 'g:/p/src/a.ts': '', 'g:/p/node_modules/empty/package.json': J({}) }, 'empty');
    expect(r).toEqual({ ok: false, reason: 'no-entry' });
  });

  it('declines builtin and non-file schemes', () => {
    expect(at({ 'g:/p/src/a.ts': '' }, 'node:fs')).toEqual({ ok: false, reason: 'unsupported' });
    expect(at({ 'g:/p/src/a.ts': '' }, 'https://x/y.js')).toEqual({ ok: false, reason: 'unsupported' });
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/module-resolver.test.ts`.

- [ ] **Step 3: Implement `src/module-resolver.ts`**

`resolveModule` order:

1. `specifier` matches `/^(node|data|http|https|file):/` or is a bare builtin the resolver
   shouldn't chase → `{ ok: false, reason: 'unsupported' }`.
2. **Relative** (`.` / `..` prefix) → `probeFile(joinPosix(dirOf(fromFile), specifier))`,
   `via: 'relative'`. `probeFile` mirrors `src/import-graph.ts`'s `resolveRelative` exactly, but
   probes the DISK (`fs.isFile`) instead of a candidate set, and orders
   `RESOLVE_EXTENSIONS = ['.d.ts', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']` — types first,
   because navigation wants the declaration. Also probe `<base>/index<ext>`, and strip a trailing
   `.js`/`.jsx`/`.mjs`/`.cjs` before probing (ESM-style TS). Say in a comment WHY the order
   differs from `import-graph`'s and link the spec; do not duplicate the rationale.
3. **tsconfig aliases**: `findNearestTsconfig(fromFile, root, fs)` → `loadTsconfigChain`.
   For each `paths` pattern, longest-literal-prefix wins (TS's rule); substitute `*`; probe each
   target with `probeFile`. `via: 'alias'`.
4. **baseUrl**: `probeFile(joinPosix(baseUrl, specifier))`, `via: 'baseUrl'`.
5. **Bare** → `splitPackageSpecifier`; for each dir in `nodeModulesDirs(dirOf(fromFile))`, if
   `<dir>/<pkg>/package.json` exists, `resolveFromPackage(pkgDir, subpath, fs)`; the first
   package directory that EXISTS wins even if its entry resolution fails (Node semantics — do
   not keep walking past a real package), except that the `@types` fallback is tried in the same
   `nodeModulesDirs` sweep before giving up.

`resolveFromPackage(pkgDir, subpath, fs)`, root subpath (`'.'`), in this order:
`types` / `typings` → `exports` via `selectExportsTarget(exports, '.')` →
`@types/<pkg>` (caller-driven) → `main` → `index.js`/`index.d.ts` probe.
For a NON-root subpath, `types`/`typings` do not apply — go
`exports` (`selectExportsTarget(exports, subpath)`, wildcard-aware) → `typesVersions` mapping via
`applyTypesVersions` → `probeFile(<pkgDir>/<subpath>)` → `@types/<pkg>/<subpath>`.
Note that ordering difference in a comment; it is TS's own behaviour, not a preference.

`selectExportsTarget(node, subpath)`: recursive. A string is the target. An object is either a
subpath map (keys starting with `.`) or a conditions map. For conditions, try
`EXPORT_CONDITIONS = ['types', 'import', 'require', 'default']` in order and recurse. For a
subpath map, exact key first, then wildcard keys (`./*`) longest-prefix-first, substituting the
captured tail. Arrays: take the first entry that resolves to a string.

`applyTypesVersions(typesVersions, subpath)`: the outer key is a semver range — accept `'*'` and
otherwise take the FIRST key (there is no TS version to compare against here; say so in a
comment). The inner map is `pattern → [target]` with `*` substitution.

`realpath` is applied to BOTH the resolved entry and the package dir before returning (rows 31,
36). Then `isSafeResolvedPath(entry)` gates the result: reject `//`-prefixed (UNC) and
`\\?\`/`\\.\` device paths → `{ ok: false, reason: 'unsafe-path' }`.

- [ ] **Step 4: Run** — `npx vitest run test/unit/module-resolver.test.ts test/unit/import-graph.test.ts`.
  Expected: PASS (`import-graph` is untouched — it stays the priority-wave scanner).
- [ ] **Step 5: Commit** — `git commit -m "feat(nav): Node/TS module resolver with exports, typesVersions, @types and realpath"`

### Task 3: `src/module-resolver-fs.ts` — real fs, bounded closure, one host entry point

**Files:**
- Create: `src/module-resolver-fs.ts`
- Test: `test/unit/module-closure.test.ts` (new; drives the closure caps through an injected
  walker so no real install is needed)

**Interfaces:**

```ts
import type { ResolveResult } from './module-resolver';

/** How much of a resolved module's own relative closure is indexed with it. Bounded because a
 *  package like `typescript` or `aws-sdk` would otherwise dwarf the whole project index. */
export const CLOSURE_FILE_CAP = 120;
export const CLOSURE_BYTE_CAP = 4 * 1024 * 1024;
/** Matches the index: a file over this is skipped, not truncated (spec §5, row 17). */
export const CLOSURE_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ResolvedModuleFiles {
  entry: string;
  packageDir?: string;
  files: { path: string; content: string; language: string }[];
}

/** Resolve `specifier` from `fromFile` against the real filesystem. */
export function resolveModuleFs(fromFile: string, specifier: string, root: string): ResolveResult;

/** Resolve, then read the entry plus its bounded relative closure. Async so the walk + reads
 *  never block the Electron main thread (same reason src/content-search-fs.ts is async). */
export function resolveModuleWithClosure(
  fromFile: string,
  specifier: string,
  root: string,
): Promise<{ ok: true; value: ResolvedModuleFiles } | { ok: false; reason: string }>;

/** Pure, injected-walk core — exported for the cap tests. */
export function boundFiles(
  ordered: readonly string[],
  read: (p: string) => { content: string; bytes: number } | null,
): { path: string; content: string }[];
```

- [ ] **Step 1: Write the failing tests** — `test/unit/module-closure.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  boundFiles,
  CLOSURE_BYTE_CAP,
  CLOSURE_FILE_CAP,
  CLOSURE_MAX_FILE_BYTES,
} from '../../src/module-resolver-fs';

const reader = (sizes: Record<string, number>) => (p: string) =>
  sizes[p] === undefined ? null : { content: 'x'.repeat(0), bytes: sizes[p] };

describe('closure bounds', () => {
  it('caps the file count', () => {
    const ordered = Array.from({ length: 500 }, (_, i) => `g:/p/n/${i}.d.ts`);
    const sizes = Object.fromEntries(ordered.map((p) => [p, 10]));
    expect(boundFiles(ordered, reader(sizes))).toHaveLength(CLOSURE_FILE_CAP);
  });

  it('stops at the byte budget even under the file cap', () => {
    const ordered = Array.from({ length: 10 }, (_, i) => `g:/p/n/${i}.d.ts`);
    const each = Math.floor(CLOSURE_BYTE_CAP / 3);
    const sizes = Object.fromEntries(ordered.map((p) => [p, each]));
    expect(boundFiles(ordered, reader(sizes)).length).toBeLessThanOrEqual(3);
  });

  it('skips an oversize file instead of truncating it — row 17', () => {
    const ordered = ['g:/p/n/big.d.ts', 'g:/p/n/small.d.ts'];
    const files = boundFiles(
      ordered,
      reader({ 'g:/p/n/big.d.ts': CLOSURE_MAX_FILE_BYTES + 1, 'g:/p/n/small.d.ts': 10 }),
    );
    expect(files.map((f) => f.path)).toEqual(['g:/p/n/small.d.ts']);
  });

  it('drops unreadable entries without failing the batch', () => {
    expect(boundFiles(['g:/p/n/gone.d.ts', 'g:/p/n/ok.d.ts'], reader({ 'g:/p/n/ok.d.ts': 5 }))).toHaveLength(1);
  });

  it('always keeps the first file when it fits — the entry must never be dropped', () => {
    expect(boundFiles(['g:/p/n/entry.d.ts'], reader({ 'g:/p/n/entry.d.ts': 10 }))[0]?.path).toBe(
      'g:/p/n/entry.d.ts',
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/module-closure.test.ts`.

- [ ] **Step 3: Implement `src/module-resolver-fs.ts`**

- `hostFsShim: FsShim` — `readText` via `fs.readFileSync(p, 'utf8')` in a try/catch,
  `isFile`/`isDirectory` via `fs.statSync` in a try/catch, `realpath` via `fs.realpathSync` with
  the input returned on failure, all normalized to forward slashes.
- `resolveModuleFs` = `resolveModule({fromFile, specifier, root}, hostFsShim)`.
- `resolveModuleWithClosure`:
  1. resolve; on failure return `{ ok: false, reason }`.
  2. Build the closure candidate set: `importClosure` (`src/import-graph.ts`) only ever returns
     members of the candidate set it is given, so walk a directory first —
     `packageDir` when there is one (rows 30/31), otherwise the entry's own directory (rows
     33/34; the next hop is covered by Plan A's hop loop or by the incremental index). Walk it
     with the existing bounded `walkFiles(dir, cap)` from `src/file-search.ts` — it already skips
     `SEARCH_IGNORE` dirs, which keeps a nested `node_modules` inside the package out of the set —
     and filter to `RESOLVE_EXTENSIONS`.
  3. `const ordered = await importClosure([entry], candidates, read, CLOSURE_FILE_CAP)` — the
     `read` callback reads through `readFile` (`src/file-service.ts`) so the size caps and the
     binary sniff are the same ones the project index obeys.
  4. `boundFiles(ordered, …)` applies `CLOSURE_MAX_FILE_BYTES` per file and `CLOSURE_BYTE_CAP`
     across the batch, in order (entry first).
  5. Tag each file's `language` with `langFromPath` (`src/lang.ts`) — the renderer needs it for
     the extraLib/tokenizer path, exactly as `projectFiles` does.
  6. Yield to the event loop between reads (`setImmediate`) the way `content-search-fs` does; a
     120-file package read must never stall PTY forwarding.

- [ ] **Step 4: Run** — `npx vitest run test/unit/module-closure.test.ts`; `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav): host wiring for module resolution with a bounded relative closure"`

### Task 4: The IPC — `resolveModule` / `resolveModuleResult`

**Files:**
- Modify: `src/protocol.ts` (`WebviewToHost` — beside `indexProject`; `HostToWebview` — beside
  `projectFiles`)
- Modify: `electron/main.ts` (new `case 'resolveModule'` in the message switch; the resolve cache)
- Test: `test/unit/module-resolver-ipc.test.ts` (new — the cache key + invalidation, pure)

**Interfaces:**

```ts
// src/protocol.ts — WebviewToHost
  // Resolve one module specifier the way Node/TS would, from the file that imports it, and
  // index the result on demand. Sent only when a navigation MISSED — see
  // docs/specs/2026-08-21-goto-definition-flows.md §1-2.
  | {
      type: 'resolveModule';
      requestId: number;
      sessionId: string;
      /** Absolute path of the importing file (forward slashes). */
      fromFile: string;
      specifier: string;
    }

// src/protocol.ts — HostToWebview
  | {
      type: 'resolveModuleResult';
      requestId: number;
      ok: boolean;
      /** The resolved entry file, when ok. */
      entry?: string;
      /** The entry plus its bounded relative closure, in the same shape as `projectFiles`. */
      files?: { path: string; content: string; language: string }[];
      /** Why it failed — surfaced in the log, never as the user-facing copy. */
      reason?: string;
    }
```

```ts
// electron/main.ts — exported from src/module-resolver-fs.ts for the unit test:
export function resolveCacheKey(root: string, fromFile: string, specifier: string): string;
```

- [ ] **Step 1: Write the failing test** — `test/unit/module-resolver-ipc.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { resolveCacheKey } from '../../src/module-resolver-fs';

describe('resolveCacheKey', () => {
  it('keys on root, importing DIRECTORY and specifier — two files in one dir share a hit', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod')).toBe(
      resolveCacheKey('g:/p', 'g:/p/src/b.ts', 'zod'),
    );
  });

  it('separates different directories — nested node_modules must not collide', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'dep')).not.toBe(
      resolveCacheKey('g:/p', 'g:/p/apps/web/src/a.ts', 'dep'),
    );
  });

  it('separates roots and specifiers', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod')).not.toBe(
      resolveCacheKey('g:/q', 'g:/q/src/a.ts', 'zod'),
    );
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod')).not.toBe(
      resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod/v3'),
    );
  });

  it('normalizes separators so a Windows path and its forward-slash twin share one entry', () => {
    expect(resolveCacheKey('g:\\p', 'g:\\p\\src\\a.ts', 'zod')).toBe(
      resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod'),
    );
  });

  it('is prefixed by the root so a whole root can be dropped by prefix — see Task 5', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod').startsWith('g:/p\0')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/module-resolver-ipc.test.ts`.

- [ ] **Step 3: Implement**

`src/protocol.ts`: add both members with the doc comments above (one comment each, pointing at
the spec — do not restate contract §1).

`electron/main.ts`, beside `fileIndexCache`:

```ts
// On-demand module resolutions, keyed by root so a whole project's entries can be dropped in
// one pass — see docs/specs/2026-08-21-goto-definition-flows.md §1 and this plan's Task 5.
const moduleResolveCache = new Map<string, ResolvedModuleFiles | { failed: string }>();
```

New case in the message switch (mirror `md:image`'s requestId echo shape):

```ts
case 'resolveModule': {
  const session = mgr.get(m.sessionId);
  const root = session?.projectPath;
  if (!root) {
    replyHere({ type: 'resolveModuleResult', requestId: m.requestId, ok: false, reason: 'no session' });
    break;
  }
  const key = resolveCacheKey(root, m.fromFile, m.specifier);
  const cached = moduleResolveCache.get(key);
  if (cached) {
    replyHere(
      'failed' in cached
        ? { type: 'resolveModuleResult', requestId: m.requestId, ok: false, reason: cached.failed }
        : { type: 'resolveModuleResult', requestId: m.requestId, ok: true, entry: cached.entry, files: cached.files },
    );
    break;
  }
  const result = await resolveModuleWithClosure(m.fromFile, m.specifier, root);
  if (!result.ok) {
    moduleResolveCache.set(key, { failed: result.reason });
    log.info('index', 'resolve-miss', { specifier: m.specifier, reason: result.reason });
    replyHere({ type: 'resolveModuleResult', requestId: m.requestId, ok: false, reason: result.reason });
    break;
  }
  moduleResolveCache.set(key, result.value);
  log.info('index', 'resolve-hit', {
    specifier: m.specifier,
    entry: result.value.entry,
    files: result.value.files.length,
  });
  replyHere({
    type: 'resolveModuleResult',
    requestId: m.requestId,
    ok: true,
    entry: result.value.entry,
    files: result.value.files,
  });
  break;
}
```

`resolveCacheKey` in `src/module-resolver-fs.ts`: normalize slashes, take the importing file's
DIRECTORY (not the file — every file in one directory resolves a bare specifier identically),
join with `\0`, root first.

- [ ] **Step 4: Run** — `npx vitest run test/unit/module-resolver-ipc.test.ts`; `npm run typecheck`
  (the protocol change ripples through both programs — fix any fallout honestly, no casts).
- [ ] **Step 5: Commit** — `git commit -m "feat(nav): resolveModule IPC with a per-root resolution cache"`

### Task 5: Cache invalidation that matches the watcher we actually have

**Files:**
- Modify: `electron/main.ts` (the `ProjectWatcher` callback that broadcasts `fsChanged`;
  `indexProjectSources`)
- Test: `test/unit/module-resolver-ipc.test.ts` (extend — the pure prefix-drop helper)

**Interfaces:**

```ts
// src/module-resolver-fs.ts
/** Drop every cached resolution belonging to `root`. Exported (and pure over the map) so the
 *  invalidation rule is testable without an Electron window. */
export function dropResolutionsForRoot(cache: Map<string, unknown>, root: string): number;
```

**Why this and not per-package invalidation** — say it once, in the code comment, and link here:
`fsChanged` carries only `{ root }` (`electron/project-watcher.ts` → `broadcast({ type:
'fsChanged', root })`), and `shouldIgnoreWatchPath` (`src/watch-filter.ts`) drops every event
containing a `node_modules` segment before the debounce fires — so an `npm install` emits no
event at all and no changed path is ever available. Root-scoped invalidation is what the
existing signal supports; a resolution costs one bounded walk and is only ever recomputed after
a navigation misses.

- [ ] **Step 1: Write the failing test** — append to `test/unit/module-resolver-ipc.test.ts`

```ts
import { dropResolutionsForRoot, resolveCacheKey } from '../../src/module-resolver-fs';

describe('dropResolutionsForRoot', () => {
  it('drops only the given root', () => {
    const cache = new Map<string, unknown>([
      [resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod'), 1],
      [resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'lodash'), 1],
      [resolveCacheKey('g:/q', 'g:/q/src/a.ts', 'zod'), 1],
    ]);
    expect(dropResolutionsForRoot(cache, 'g:/p')).toBe(2);
    expect([...cache.keys()]).toHaveLength(1);
  });

  it('does not drop a sibling root that shares a prefix', () => {
    const cache = new Map<string, unknown>([
      [resolveCacheKey('g:/proj', 'g:/proj/a.ts', 'zod'), 1],
      [resolveCacheKey('g:/proj-two', 'g:/proj-two/a.ts', 'zod'), 1],
    ]);
    expect(dropResolutionsForRoot(cache, 'g:/proj')).toBe(1);
  });

  it('normalizes the root it is given', () => {
    const cache = new Map<string, unknown>([[resolveCacheKey('g:/p', 'g:/p/a.ts', 'zod'), 1]]);
    expect(dropResolutionsForRoot(cache, 'g:\\p')).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/module-resolver-ipc.test.ts`.

- [ ] **Step 3: Implement** — `dropResolutionsForRoot` deletes keys starting with
  `${normalized(root)}\0` (the `\0` is what makes the sibling-prefix case safe). Call it from
  two places in `electron/main.ts`:
  - inside the existing `ProjectWatcher` callback, next to `broadcast({ type: 'fsChanged', root })`;
  - at the top of `indexProjectSources` (a re-index means the tree was re-read).

- [ ] **Step 4: Run** — `npx vitest run test/unit/module-resolver-ipc.test.ts`; `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "fix(nav): drop cached resolutions when a root changes or is re-indexed"`

### Task 6: Renderer — supplemental extraLibs and the retry hook

**Files:**
- Modify: `webview/ts-project.ts` (add `addIndexedFiles`)
- Create: `webview/resolve-module.ts`
- Modify: `webview/app.tsx` (register the hook in the same effect that calls
  `setDefinitionOpener` / `registerConduitEditorOpener`)
- Test: `test/unit/ts-index-state.test.ts` (extend — supplemental files must not move the
  index counters)

**Interfaces:**

```ts
// webview/ts-project.ts
/** Push files the project index did NOT select (an on-demand module resolution) to the worker.
 *  Deliberately does NOT touch the index tracker: `loaded`/`total` describe the PROJECT index,
 *  and "N of M" would start lying the moment a package landed. */
export function addIndexedFiles(files: readonly { path: string; content: string }[]): void;

// webview/resolve-module.ts
/** Ask the host to resolve `specifier` from `fromFile` and push what it finds to the worker.
 *  Resolves to whether the navigation is worth retrying. */
export function resolveModuleOnDemand(
  sessionId: string | null,
  fromFile: string,
  specifier: string,
): Promise<boolean>;
```

- [ ] **Step 1: Write the failing test** — append to `test/unit/ts-index-state.test.ts`

```ts
it('supplemental files never move the project index counters', () => {
  const tracker = createIndexTracker();
  tracker.note('g:/p', 900, false);
  tracker.markLoaded(200);
  const before = tracker.status();
  // addIndexedFiles must not call markLoaded/note — this asserts the CONTRACT the renderer
  // relies on: "Still indexing (200 of 900)" stays true while a package is pulled in.
  expect(before).toEqual({ total: 900, loaded: 200, done: false });
});
```

  That is a contract note more than a behavioural test. The real guard is a grep-shaped
  assertion in review: `addIndexedFiles` must not reference `tracker`. If a stronger net is
  wanted, extract the extraLib push into a tiny injected sink and test it — but do not build a
  monaco double for it.

- [ ] **Step 2: Implement `webview/ts-project.ts`**

```ts
export function addIndexedFiles(files: readonly { path: string; content: string }[]): void {
  for (const f of files) {
    const uri = fileUri(f.path).toString();
    monacoTs.typescriptDefaults.addExtraLib(f.content, uri);
    monacoTs.javascriptDefaults.addExtraLib(f.content, uri);
  }
}
```

  Same `addExtraLib` discipline as `flush`/`refreshIndexedFile` (never `setExtraLibs` — CLAUDE.md).
  These files must **never** travel as a `projectFiles` chunk: `applyProjectFiles` sets compiler
  options on `seq === 0`, which disposes the running worker and would throw away everything
  already pushed.

- [ ] **Step 3: Implement `webview/resolve-module.ts`**

  A `requestId` round-trip over `post`/`subscribe` (`webview/bridge.ts`), modelled on
  `webview/components/markdown-viewer.tsx`'s `md:image` handling: monotonic counter, one
  `subscribe` per request torn down in a `finally`, and `withTimeout` (`src/with-timeout.ts`) so
  a host that never answers can't wedge the navigation inside Plan A's deadline. On `ok`, call
  `addIndexedFiles(files)` and return `true`; otherwise return `false`. In-flight de-duplication:
  keep a `Map<string, Promise<boolean>>` keyed by `${fromFile}\0${specifier}` so a hop chain or a
  double-click can't fan out duplicate host work.

  `fromFile` arrives from `ts-nav.ts` as a monaco URI string (`file:///g:/…`). Convert it with
  `uriToAbsPath(monaco.Uri.parse(fromFile))` (Plan A Task 2) before posting — the host resolves OS
  paths, and the reply's `files[].path` goes back through `fileUri()` inside `addIndexedFiles`,
  which is what keeps the key space identical to the project index's.

- [ ] **Step 4: Wire it in `webview/app.tsx`** — in the existing effect that calls
  `setDefinitionOpener(...)` and `registerConduitEditorOpener()`:

```ts
setUnresolvedResolver((fromFile, specifier) =>
  resolveModuleOnDemand(activeIdRef.current, fromFile, specifier),
);
```

  and `setUnresolvedResolver(null)` in that effect's cleanup. Use `activeIdRef` (already present
  for exactly this reason) rather than adding `activeId` to the dependency array — re-running the
  effect would re-register the Monaco-global opener and providers.

- [ ] **Step 5: Run** — `npx vitest run test/unit/ts-index-state.test.ts`; `npm run typecheck`;
  `npm run fallow:check`.
- [ ] **Step 6: Commit** — `git commit -m "feat(nav): push on-demand resolutions to the worker and retry the navigation"`

### Task 7: E2E — rows 6, 7, 19, 22–36 + full verify

**Files:**
- Modify: `test/e2e/goto-matrix.e2e.mjs` (the rows this plan owns; the scenario and
  `test/e2e/fixtures/goto/build-fixture.mjs` come from the fixture task — **do not create them
  here**; if absent, STOP and report)
- Modify: `docs/specs/INDEX.md`, `CHANGELOG.md` (`## [Unreleased]` → Added: Go to Definition now
  works into packages, monorepo siblings, and files outside the indexed set)

**Interfaces:** consumes everything above through the real app.

- [ ] **Step 1: Capture the red** — run the matrix against the pre-change build and save the
  output. Every row below must fail (rows 25–36 are ❌ by construction today).
- [ ] **Step 2: Make this plan's rows green.** Per row, assert the LANDED path and that the
  outcome message is not an error:
  - **6, 7** — barrel and 3-level `export *`: land in the defining file, not the barrel. Row 7
    exercises Plan A's `NAV_HOP_CAP` chain; assert the final landing, and log the hop count if
    the scenario exposes it.
  - **19** — alias from `tsconfig.app.json` at the app level.
  - **22** — `extends: "@tsconfig/node20"`: the alias declared by the extended package resolves.
  - **23** — a `references`-contributed alias resolves.
  - **24** — two sessions with different tsconfigs open at once: BOTH still navigate, and
    `window.monaco.languages.typescript.typescriptDefaults.getCompilerOptions()` is unchanged
    across the second session opening (no worker restart — the per-package aliases were handled
    host-side).
  - **25** — `zod`: lands in `node_modules/zod/*.d.ts`.
  - **26** — `exports` + `typesVersions` package.
  - **27** — `lodash` via `@types/lodash`.
  - **28** — untyped JS package: lands on the JS entry.
  - **29** — `date-fns/format` subpath.
  - **30** — a barrel chain INSIDE a package: lands in `lib/x.d.ts`, not `index.d.ts`.
  - **31** — workspace sibling behind a junction: the landed path is the REAL package dir, not
    the `node_modules` link path.
  - **32** — sibling via a package-level `paths`.
  - **33** — `../shared/x` above the session root.
  - **34** — a file past the 5000 cap: resolved on demand.
  - **35** — a file created after the index ran: resolve it via a navigation before any re-index.
  - **36** — a nested/pnpm-shaped `node_modules`: the NEAREST copy wins.

  Row 17 (>2 MB) and the cap/skip counters in the status line belong to the index-hygiene task —
  leave those rows exactly as they are.
- [ ] **Step 3: Prove the cache does its job** — after row 25 passes, re-run the same navigation
  and assert the second one produces no new `resolveModule` host work (spy on it with the
  harness's `spyMain`, or assert the round-trip latency drops below a threshold — prefer the spy;
  a timing assertion on a loaded machine is a flake generator).
- [ ] **Step 4: Serial regression** — one at a time: `goto-index`, `goto-matrix`,
  `editor-first-paint`, `quickopen-corpus`, `live-watch`. Any failure: re-run ALONE first.
- [ ] **Step 5: Full gate** — `npm run verify` in the worktree, complete unfiltered output
  captured to evidence (never `| tail` it). Read the tail yourself.
- [ ] **Step 6: Commit** — `git commit -m "test(nav): e2e proof for on-demand module resolution (rows 6,7,19,22-36)"`

## Self-review notes (already applied)

- Spec §1 maps to Tasks 1–3 (resolution + closure) and 4 (the IPC); §2's "unresolved specifier is
  the trigger" is Plan A's classifier plus this plan's Task 6 hook; the cache clause of §1 is
  Task 5. Rows 6, 7, 19, 22–36 each have a named e2e assertion in Task 7.
- Rows deliberately NOT here: 4 (`.mts` ScriptKind), 15 (dot-dir narrowing), 17 (>2 MB skip), 35's
  incremental-index half, and the status-line cap/skip counts — all spec §5, owned by the
  index-hygiene task. Rows 42/43/44 are §4's path-identity task. Row 24 needs no code change
  (assertion only), which is exactly what Task 7 checks.
- Names cross-checked across tasks: `FsShim`, `findNearestTsconfig`, `loadTsconfigChain`,
  `TSCONFIG_CANDIDATES`, `ResolvedTsconfig`, `resolveModule`, `ResolveResult`, `nodeModulesDirs`,
  `splitPackageSpecifier`, `typesPackageName`, `probeFile`, `selectExportsTarget`,
  `applyTypesVersions`, `isSafeResolvedPath`, `RESOLVE_EXTENSIONS`, `EXPORT_CONDITIONS`,
  `resolveModuleFs`, `resolveModuleWithClosure`, `boundFiles`, `CLOSURE_*`, `resolveCacheKey`,
  `dropResolutionsForRoot`, `addIndexedFiles`, `resolveModuleOnDemand`.
- `nodeModulesDirs` has exactly one owner (`src/module-resolver.ts`) and one importer
  (`src/tsconfig-discovery.ts`) — no duplicate walk-up implementation.
- Purity boundary is explicit: only `src/module-resolver-fs.ts` may import `node:fs`. That is what
  keeps `npm run typecheck`'s webview pass clean if anything renderer-side ever imports the core.
- **Deviations from the handed-down decisions, flagged not silently taken** — see the report:
  (a) cache invalidation is ROOT-scoped, because `fsChanged` carries no path and `node_modules`
  events are filtered out entirely; (b) host wiring lives in `src/module-resolver-fs.ts` rather
  than inline in `electron/main.ts`, matching the `content-search` / `content-search-fs` split
  (the cache Map itself stays in `main.ts` as decided); (c) for a NON-root subpath, `exports` /
  `typesVersions` are consulted before `types`/`typings`, because `types` only ever describes the
  package root — the decision's ordering is kept verbatim for the `'.'` subpath.
- Line numbers are not cited anywhere on purpose — re-locate by symbol before editing.

---
status: draft
date: 2026-08-21
tier: FULL
---

# Go to Definition — flow map and resolution contract

## Why

"Go to Definition sometimes does nothing." The 2026-08-21 investigation mapped the
pipeline (editor menu → `runNavCommand` → Monaco command → our TS worker over
extraLibs → `registerEditorOpener` → `openFile`) and evaluated 40 flows against it.
Two findings frame everything:

1. **Coverage:** the index is `git ls-files` (or a walk) under the session root,
   filtered to source extensions, dot-dirs dropped, alphabetically capped at 5000,
   fed to the worker as extraLibs. **`node_modules` is never indexed**, only
   `<root>/tsconfig.json` is read, nothing above the root or created after the
   index exists, and there is no fallback resolver. So every bare package import,
   every monorepo sibling, every `../shared` file, and every capped/new file is
   unreachable — by construction, not by bug. The archived nav-parity spec's §3g
   (on-demand dependency types) was never built.
2. **Feedback:** the wrapper (`webview/ts-nav.ts`) infers success from "did the
   editor move"; once the index is complete it says nothing at all, and Monaco's own
   early returns (cancellation on model change, provider-precondition false, no
   active editor) are silent. Peek results don't "move", so the one message that
   exists ("still indexing") fires spuriously on *successful* peeks. When Monaco
   does speak, it says "No definition found for 'zod'" — factually wrong.

## Flow map

**Observed baseline (2026-08-21, real app on the fixture — `.autoloop/evidence/goto-fixture-baseline.txt`, 49 probes: 20 pass / 28 fail / 1 inconclusive).** Corrections to the predictions below: (a) every ❌ row whose *specifier* fails to resolve does **not** show "No definition found" — TS resolves the binding to its own import clause, so the caret **silently jumps to the import line** in the same file (the reported "nothing happens"); Monaco's message appears only where there is no import to fall back to (rows 15, 22, 40). (b) Row 45's "still indexing" toast never fires — the caret moved, so the `moved` heuristic reports success; rows 12/13's spurious toast is unreachable once the index is ready. (c) Row 4 (`.mts`) **works** — dropped from contract 5. (d) Row 44 passed while 42 failed (same defect, unexplained asymmetry) — 44 is not safe. (e) Row 24 is worse than "last-set-wins": opening a second root breaks the first root's alias for the rest of the window. (f) Row 17: the 2 MB truncation happens in `src/file-service.ts` `readFile`, upstream of the index.

Current = predicted from code (2026-08-21). Target = this spec's contract.
Legend: ✅ works · ⚠️ partial · ❌ fails (Monaco's misleading "No definition found")
· 🔇 fails silently.

### First-party resolution

| # | Flow | Current | Why | Target |
|---|---|---|---|---|
| 1 | Same-file symbol | ✅ | mirror model | ✅ |
| 2 | Relative `./foo` | ✅ | extraLib key space | ✅ |
| 3 | Extension omitted; `.ts`/`.tsx`/`.js` siblings | ✅ | TS probing | ✅ |
| 4 | `./x.mts` / `.cts` with type annotations | ✅ (observed) | predicted ScriptKind issue did not reproduce | ✅ |
| 5 | Directory import → `dir/index.ts` | ✅ | | ✅ |
| 6 | Barrel `export { X } from './x'` → lands in `x.ts`, not the barrel | ✅ iff `x.ts` indexed | alias resolution in-program | ✅ always (on-demand index) |
| 7 | `export *` chain, 3 levels | ✅ iff whole chain indexed | | ✅ always |
| 8 | `export { X as Y }` rename re-export | ✅ | | ✅ |
| 9 | `export default function` | ✅ | | ✅ |
| 10 | `import type { T }` through a barrel | ✅ | | ✅ |
| 11 | JSX `<Foo />` → component | ✅ | jsx mapped | ✅ |
| 12 | Overload / enum member → multiple results (peek) | ✅ but spurious "still indexing" toast | peek doesn't "move" | ✅ no toast |
| 13 | Cursor already on the declaration → references peek | ✅ + spurious toast | same | ✅ |
| 14 | Ambient `declare global` / project `.d.ts` | ✅ | | ✅ |
| 15 | Declarations under `.storybook/`, `.config/`, `.github/scripts` | ❌ | every dot-dir dropped | ✅ only tool-state dirs dropped (`.git`, `.claude`, `.conduit`, …) |
| 16 | Unsaved edits in the target (dirty tab) | ✅ | mirror wins | ✅ |
| 17 | Source file > 2 MB | 🔇 truncated silently | index pushes truncated text | ⚠️ skipped + counted, surfaced in status |

### Configuration

| # | Flow | Current | Why | Target |
|---|---|---|---|---|
| 18 | `paths` alias `@/lib/foo` in `<root>/tsconfig.json` | ✅ | forwarded | ✅ |
| 19 | Alias defined in `tsconfig.app.json` / `tsconfig.base.json` / `jsconfig.json` | ❌ | only root `tsconfig.json` read | ✅ nearest config to the importing file, standard names |
| 20 | `baseUrl` non-relative import | ✅ (root config only) | | ✅ |
| 21 | `extends: "./tsconfig.base.json"` (≤3 deep) | ✅ | | ✅ |
| 22 | `extends: "@tsconfig/node20"` (package) | ❌ dropped | relative-only | ✅ resolved via node_modules |
| 23 | `references` (project references) | ❌ ignored | | ⚠️ referenced configs' `paths` honored by the host resolver; not a full build graph |
| 24 | Two sessions with different tsconfigs in one window | ⚠️ last-set-wins, worker restarts | global compiler options | ✅ worker keeps root config; per-file aliases resolved host-side, no restart |

### Beyond the index (the user's headline)

| # | Flow | Current | Why | Target |
|---|---|---|---|---|
| 25 | Bare package with `types` (`zod`) | ❌ | node_modules never indexed | ✅ lands in `node_modules/zod/*.d.ts` |
| 26 | Package with `exports` map + types condition / `typesVersions` | ❌ | | ✅ |
| 27 | `@types/*` package (`lodash`) | ❌ | | ✅ |
| 28 | Untyped JS package | ❌ | | ✅ lands on the JS entry (`main`/`exports`) |
| 29 | Subpath `date-fns/format` | ❌ | | ✅ |
| 30 | Barrel chain INSIDE a package (`index.d.ts` → `./lib/x.d.ts`) | ❌ | | ✅ package's relative closure indexed with it (bounded) |
| 31 | Monorepo sibling via workspace symlink/junction | ❌ | | ✅ realpath'd, indexed on demand |
| 32 | Monorepo sibling via `paths` in a package-level tsconfig | ❌ | (19) + (24) | ✅ |
| 33 | `../shared/x` above the session root | ❌ | | ✅ resolved from the importing file; opened + indexed |
| 34 | File beyond the 5000 cap | ❌, cap never announced | alphabetical truncation | ✅ resolved on demand; cap surfaced in status |
| 35 | File created after the index ran | ❌ forever | `indexedRoots` never invalidated | ✅ incremental index on `fsChanged` add + on-demand resolve |
| 36 | pnpm / nested `node_modules` / hoisting | ❌ | | ✅ walk-up resolution from the importing file with realpath |

### Feedback and identity

| # | Flow | Current | Why | Target |
|---|---|---|---|---|
| 37 | Zero results, index complete | ❌ Monaco's wrong message; wrapper silent | | ✅ classified outcome: "not indexed — resolving…" → lands, or an honest "no definition" |
| 38 | Nav cancelled by a concurrent model re-seed / tab switch | 🔇 | `EditorStateCancellationTokenSource` | ✅ retried once / reported |
| 39 | F12 before Monaco's TS providers register (first file) | 🔇 | precondition false → silent | ✅ wait for provider or report |
| 40 | Right-click on whitespace / keyword / string | ❌-ish | | ✅ "Nothing to navigate to here" |
| 41 | Non-TS file (`.vue`, `.py`) | ✅ greyed/toast | | ✅ |
| 42 | Drive-letter casing: nav lands in `g:/…` while the tree opened `G:\…` | ⚠️ duplicate tab, separate dirty/view state | `Uri.path` lowercases the drive | ✅ one canonical path key |
| 43 | Path containing `#`, `?`, `%` | 🔇 extraLib key truncated | `Uri.parse` fragment | ✅ escaped |
| 44 | Target already open in a dirty tab | ⚠️ second tab on the same model | (42) | ✅ switches to the tab |
| 45 | While indexing (pre-deadline) | ✅ "still indexing (N of M)" | | ✅ + "resolving <pkg>…" for on-demand |

## Contract

1. **Resolve anything, index on demand.** A new host IPC
   `resolveModule({ fromFile, specifier })` implements Node/TS resolution from the
   importing file: relative (any depth, above the root included), nearest-tsconfig
   `paths`/`baseUrl` (config discovery walks up from the file: `tsconfig.json`,
   `tsconfig.app.json`, `tsconfig.base.json`, `jsconfig.json`; `extends` incl.
   package form; `references` contributing their `paths`), and bare specifiers via
   walk-up `node_modules` (`package.json` `types`/`typings`, `exports` with
   `types`/`import`/`default` conditions, `typesVersions`, subpaths, then
   `@types/<pkg>`, then `main`/JS entry), with `realpath` for symlinks/junctions.
   The result (entry file + its relative closure, bounded by files and bytes) is
   pushed as extraLibs exactly like project files, and the navigation is retried.
   Resolutions are cached per (root, specifier) and invalidated on `fsChanged`
   under the resolved package/dir.
2. **The worker's unresolved specifier is the trigger, not "bare vs relative".** On
   an empty definition result, the wrapper asks the worker for the specifier under
   the cursor (or the import the symbol came through — via the alias chain) and
   calls (1). One retry; then an honest outcome.
3. **Explicit outcome, always visible.** `runNavCommand` runs the provider itself and
   classifies `{ navigated | peeked | resolving | none | unsupported | timed-out }`;
   Monaco's inline message is replaced by Conduit's (never "No definition found"
   for something that merely isn't indexed). `resolving` shows what is being
   fetched; `none` says nothing exists at that position. The `moved` heuristic is
   deleted.
4. **One path identity.** The opener maps a result URI back to a canonical OS path
   (drive case, separators) equal to what the tree/tabs use; `fileUri` escapes
   `#`/`?`/`%`. A navigation into an open tab activates it.
5. **Index hygiene.** Dot-dir exclusion narrows to a tool-state list; >2 MB files are skipped and counted; the cap and skip
   counts are surfaced in the "still indexing / indexed N of M" status; new files
   under the root are indexed incrementally on `fsChanged`.

Out of scope (recorded): "Go to Source Definition" (`.d.ts` → `.ts` via
`declarationMap`; `getSourceMapper` exists in the bundle, `getSourceDefinition`
does not) — follow-up once (1) lands. Full project-references build graphs.

Also out of scope, and **pre-existing** (found while building (1), 2026-08-26):
**navigation into a DEFAULT LIB file never lands.** `toLocations` (`webview/ts-nav.ts`) drops any
target it holds no content for, and monaco's bundled `lib.*.d.ts` live inside the worker rather
than in `extraLibs` — so Go to Definition on `Promise`, `Array.prototype.at`, `string` and every
other built-in reports "No definition for 'x' here" whatever the project's `target` is. That is
why matrix row 22 asserts the worker's `compilerOptions.target` rather than a landing. Fixing it
needs the worker to hand back lib text (a `getScriptText`-shaped addition to
`webview/ts.worker.ts`), which is its own change.

## Verification

A checked-in fixture workspace under `test/e2e/fixtures/goto/` covering every row
(monorepo with two packages + a workspace symlink, a `node_modules` with `types`,
`exports`+`typesVersions`, `@types`, untyped-JS and subpath packages, alias configs
at root and app level, a package-form `extends`, dot-dir declarations, a `c#` dir,
a >2 MB generated file, barrel chains 3 deep in both project and package). Real-app
e2e drives F12 / context menu per row and asserts the landed path + line and the
visible outcome message; the pre-fix build must fail every ❌/🔇/⚠️ row. Unit tests
cover the resolver (package.json shapes, exports conditions, typesVersions, walk-up,
realpath), config discovery, outcome classification, and path canonicalisation.

---
status: shipped
date: 2026-08-07
---

# Feature Spec: Editor navigation parity (goto family, instant open, fast resolution)

**Tier:** FULL   **Feature type:** UI (code editor surface + the indexing that backs it)
**Mode:** interactive

**One-line request (verbatim):**

> 1. Functionalities such as go to definition, go to type definition, go to source
> definition, go to implementations, go to references, those things that we need in our
> context, inside the code editors, because we need to be able to very smoothly move
> between files.
> 2. When I open a new file, let's say a TypeScript file, for a second I see a flash of
> unstyled text and that's not ideal. When I open something it should be styled from the
> beginning, not for a second load and then colors.
> On top of that … I try to right-click [an import] and then say go to definition and then
> I see the resolving definition message pop up and stay there for a long time without ever
> resolving. We need to be fast at going to definition. We need to be fast at opening. We
> need to achieve parity with VS Code because the editor is useless if I can't move between
> files quickly enough.

---

## 0. Root-cause findings (evidence, not hypothesis)

Every claim below was read out of the installed `monaco-editor@0.55.1` sources or this repo.
They matter because three of them **invalidate decisions currently recorded in `CLAUDE.md`
and in `docs/specs/archive/2026-06-11-goto-def.md`**.

**R1 — Monaco's built-in navigation was never broken by esbuild. It was broken by the
standalone editor service.**
`StandaloneCodeEditorService.findModel(editor, resource)` returns `null` whenever the target
URI differs from the editor's own model; `doOpenEditor` then returns `null` and the command
silently no-ops (`monaco-editor/esm/vs/editor/standalone/browser/standaloneCodeEditorService.js`
:82–88). Nothing to do with bundling. Monaco ships the public fix:
`monaco.editor.registerEditorOpener(opener)` (`editor.api.d.ts`:1156–1175). The CLAUDE.md
gotcha ("esbuild doesn't reliably bundle Monaco's native goto") is a misdiagnosis and must be
rewritten as part of this work.

**R2 — The project index silently drops source files.**
`indexProject` (`electron/main.ts`:1897) calls `walkFiles(m.root)`, whose `DEFAULT_CAP` is
**4000 files of any type**, collected breadth-first (`src/file-search.ts`:14, 28–47).
`selectIndexHits` filters to source extensions *after* that truncation. On any repo with a
few thousand docs/assets/fixtures, source files in deep directories are never seen — the
exact failure `src/source-index.ts`:6–10 claims to have fixed by raising its own cap to 3000.
A file the TS worker holds no content for is invisible to module resolution, so
go-to-definition into it cannot work, ever. This is the most likely cause of the reported
"go to definition on an import never resolves".

**R3 — Indexing does its expensive work on the renderer's main thread, at the worst moment.**
The index is requested on the **first code-file open** (`webview/app.tsx`:1075–1081), and the
reply is handled by `indexModels`, which constructs **one `monaco.editor.createModel` per
project file in a synchronous loop** (`webview/project-index.ts`:11–22). With
`setEagerModelSync(true)` each model is also mirrored to the TS worker. So opening your first
`.ts` file kicks off hundreds-to-thousands of model constructions plus a multi-megabyte
structured clone, on the same thread that is trying to paint the editor you just opened.
That is simultaneously the "flash" amplifier and the "first goto takes forever" cause.

**R4 — Monaco does not need models to answer navigation. It needs *content*.**
`TypeScriptWorker.fileExists(path)` is `this._getScriptText(path) !== undefined`, and
`_getScriptText` falls back to `this._extraLibs[fileName].content`; `getScriptFileNames()`
returns mirror models **concatenated with `Object.keys(this._extraLibs)`**
(`tsWorker.js`:38–42, 63–79, 137–142). So files pushed via the public
`typescriptDefaults.setExtraLibs([{content, filePath}])` are fully resolvable as modules with
**zero Monaco models**. And `LibFiles.getOrCreateModel` materialises a model **on demand from
`typescriptDefaults.getExtraLibs()`** when a definition lands in a file that has none
(`languageFeatures.js`:139–153). The 3000-models-up-front design is unnecessary.

**R5 — The flash is Monaco's lazy tokenizer, not a theme problem.**
`registerLanguage` wires the grammar behind `registerTokensProviderFactory({ create: async … })`
with a dynamic `import()` (`basic-languages/_.contribution.js`:103–118). The first paint is
therefore always null-tokenized (plain text), and only repaints once the factory resolves. In
an esbuild **iife** bundle the grammar module is already inlined — the laziness buys literally
nothing and costs a visible unstyled frame, stretched to ~a second whenever the main thread is
busy (see R3).

**R6 — Two of the requested commands have no provider at all.**
`tsMode.js`:114–196 registers completion, signature help, hover, document highlight,
**definition**, **references**, symbols, rename, formatting, code actions, inlay hints — and
**not** type-definition or implementation. The underlying APIs *do* exist in the bundled
`typescriptServices.js` (`getTypeDefinitionAtPosition`, `getImplementationAtPosition`,
`getFileReferences`, `prepareCallHierarchy`), they are simply not exposed on the worker.
`getSourceDefinitionAndBoundSpan` is **absent** — "Go to Source Definition" has no backing API.

**R7 — Nothing times out.** `goToDefinition` (`code-viewer.tsx`:224–264) awaits the worker with
no deadline, so a request that never settles leaves "Resolving definition…" on screen forever —
exactly what was reported. `src/with-timeout.ts` already exists and is used for terminal links.

**R8 — The project's own `tsconfig.json` is ignored.** `monaco-setup.ts`:26–36 hardcodes
compiler options. Any repo using `baseUrl`/`paths` aliases (`@/foo`) cannot resolve a single
aliased import, in any of these commands.

---

## 1. Problem frame

**Job.** *When I'm reading code in Conduit, let me move between files as fast as I think* —
click a symbol, land on its definition, see who calls it, come back — without waiting, without
guessing whether it's working, and without the editor looking half-rendered on the way.

**Actors.** The developer reading/reviewing code in Conduit's editor (the only actor; no host
or agent-facing behavior changes).

**Success outcomes (observable).**
- The VS Code navigation set is present in the editor context menu and on the VS Code
  keybindings, and each one **works cross-file**.
- Opening a code file paints **syntax-coloured on the first frame**. No unstyled frame, ever.
- Go-to-definition on an import resolves in well under a second on a warm session, and can
  **never** hang: it either navigates, says "no definition found", or says why it can't answer
  yet — bounded by a deadline.
- Resolution correctness no longer depends on how many non-source files happen to sit near the
  top of the repo tree.

**Non-goals.**
- Diagnostics / red squiggles. `noSemanticValidation` stays on; this is a *reader's* editor.
- Multi-file refactors (Rename Symbol, Change All Occurrences, Refactor…, Source Action…).
  They imply writing files that aren't open. Explicitly deferred (§6).
- "Go to Source Definition" — no backing API (R6), and with no dependency `.d.ts` indexed there
  is nothing for it to jump *from*. Omitted, not stubbed. (§12 A4.)
- Call hierarchy, Jest/test-runner integration, "Add Symbol to Chat" (Cursor-specific rows in
  the reference screenshot).
- Language servers for non-JS/TS languages. Navigation stays TS/JS-only; the *flash* fix is
  language-agnostic.

---

## 2. Behavior & states

### 2a. Navigation request (per invocation)

```
idle ──trigger──▶ resolving ──▶ navigated            (single result, other file → tab opens)
                     │        ├─▶ revealed           (single result, same file → cursor moves)
                     │        ├─▶ peeked / listed    (multiple results → peek or references widget)
                     │        ├─▶ not-found          ("No definition found" style message)
                     │        ├─▶ not-ready          ("Still indexing this project — N of M files")
                     │        └─▶ timed-out          ("Couldn't resolve in time. Retry.")
```

- `resolving` keeps the existing non-blocking indicator (ref-counted `gotoInflight`, the
  `role="status"` line). The editor stays fully interactive.
- **Deadline:** every worker round-trip is wrapped in `withTimeout` (§3d). There is no terminal
  state that leaves the indicator up.
- `not-ready` is a distinct, honest state: if the index is still streaming and the request found
  nothing, we say so rather than claiming "no definition found".
- Every navigation that changes file **pushes onto the existing `src/nav-history.ts` stack**, so
  Alt+←/mouse-back returns to the origin (that subsystem already exists — extend, don't rebuild).

### 2b. Project index lifecycle (per project root, per window)

```
absent ──project opens──▶ priority wave ──▶ streaming ──▶ complete
                              │                  │
                              └── (open file + its direct imports)
                                                 └── remaining source files, chunked
```

- **Priority wave** — the seed files plus the transitive closure of their relative imports,
  pushed first (`src/import-graph.ts`, capped at 300). This is the user's own instinct
  ("preload what's in view and its imports") expressed as an ordering, not a second mechanism.
  **As built, the wave only has seeds when indexing is triggered by a file open in a root that
  hasn't been indexed yet.** The common path — indexing kicked off when the session opens —
  has no file on screen to seed with, and doesn't need one: it starts before any interaction,
  so there is nothing to be ahead of. Re-prioritising a stream already in flight (the case that
  would matter on a very large repo) is deliberately not built; it needs per-root stream state
  in the host, and the honest "still indexing (N of M)" message covers the gap meanwhile.
- **Streaming** — the rest of the project's source files, in chunks, yielding between chunks so
  no single chunk blocks a frame.
- **complete** — full-project answers are now correct (this matters for *References*, which is
  only complete once every file that could mention the symbol is present).
- Re-index on demand (project switched, explicit refresh); staleness handling in §4.

### 2c. File open (the flash)

```
tab opens ──▶ tokenizer for `doc.language` ensured SYNCHRONOUSLY ──▶ editor.create ──▶ first paint (coloured)
```

There is no intermediate "plain text" state. That's the whole requirement.

---

## 3. Data / interface contract

### 3a. Editor opener (renderer, registered once)

```ts
// webview/monaco-opener.ts
monaco.editor.registerEditorOpener({
  openCodeEditor(source, resource, selectionOrPosition): boolean {
    // file:// only. Map Uri → absolute path, stage a reveal, open/focus the Conduit tab.
    // Return true iff we handled it; false lets Monaco fall through.
  }
});
```

- Reuses the existing `setReveal` / `openDefinitionFile` seam in `webview/project-index.ts`, so
  reveal-vs-restore precedence (spec 2026-06-30 §3) is unchanged.
- Registered **once at app boot**, not per editor — it is global to Monaco.
- Invariant: an opener that returns `true` must *always* result in the tab existing and the
  position revealed, or return `false`. Never a silent `true`.

### 3b. Project source push (replaces `indexModels`)

Host → renderer, `projectFiles` gains streaming fields (`src/protocol.ts`):

```ts
{ type: 'projectFiles'; root: string;
  files: { path: string; content: string; language: string }[];
  seq: number;          // chunk ordinal, 0-based
  total: number;        // total source files selected for this root
  done: boolean;        // last chunk
  compilerOptions?: TsCompilerOptionsDTO;  // present on seq === 0 only
}
```

Renderer side (`webview/ts-project.ts`, replacing `indexModels`):

```ts
setProjectFiles(root, chunk): void   // accumulates, then typescriptDefaults.setExtraLibs(all)
                                     // AND javascriptDefaults.setExtraLibs(all)
```

- **No `monaco.editor.createModel` for un-opened files.** Models exist only for open tabs and
  for files Monaco materialises on demand (R4).
- `setExtraLibs` is called **once per chunk** (batched, replaces the whole map) — that fires
  `onDidExtraLibsChange` → `_updateExtraLibs` → one `postMessage`. It does **not** restart the
  worker.
- Both `typescriptDefaults` and `javascriptDefaults` get the same records, so navigation from a
  `.js` file works identically (they are separate workers with separate `createData.extraLibs`).
- Key = the exact `fileUri(path).toString()` string, so extraLib keys, model URIs and
  resolved module names share one key space.

### 3c. tsconfig → Monaco compiler options (host, pure)

```ts
// src/tsconfig-map.ts  (pure, unit-tested, no fs)
readTsconfigChain(rootFiles): RawTsconfig     // extends chain, bounded depth 3
toMonacoCompilerOptions(raw, rootUri): TsCompilerOptionsDTO
```

- Maps string enums (`target`, `module`, `moduleResolution`, `jsx`) to Monaco's numeric enums;
  unknown/absent values fall back to today's hardcoded defaults.
- **`baseUrl` and `paths` must be rewritten into the `file:///` URI key space** (the worker's
  "paths" are URI strings, not OS paths). This is the one genuinely tricky mapping and gets its
  own unit tests.
- **Ordering gotcha:** `typescriptDefaults.setCompilerOptions()` fires `onDidChange`, and
  `WorkerManager` **disposes the running worker** on that event (`workerManager.js`:82). Compiler
  options must therefore be applied **before** the first extraLib push, once per root — never
  interleaved with streaming, or every chunk kills and restarts the worker.

### 3d. Bounded, observable command execution

```ts
// webview/monaco-commands.ts
executeEditorCommand(editor, commandId): Promise<unknown>
// webview/ts-nav.ts
runNavCommand(editor, commandId)   // focus → indicator → withTimeout(6s) → honest outcome
```

**Found during implementation:** the goto commands are registered with `registerAction2`, i.e.
as *commands*, not editor actions — so `editor.getAction('editor.action.revealDefinition')`
returns **null** and the obvious `getAction(id).run()` silently does nothing. The public
`editor.trigger(source, id, payload)` does reach them but discards the command service's
promise, leaving the navigation unbounded. So `executeEditorCommand` goes through the command
service (`StandaloneServices.get(ICommandService)`), falling back to `editor.trigger` if a
future monaco reshuffles that: navigation still works, it just loses its deadline.

Two further consequences:
- These commands resolve their target from the **focused** editor (`EditorAction2.run` looks it
  up), so `runNavCommand` must focus first — a menu click has moved focus away.
- The VS Code accelerators are re-bound to Conduit actions that delegate to the same commands.
  Monaco binds them itself, but its binding runs the command directly, skipping the indicator,
  the deadline and the still-indexing message — the keyboard path has to behave like the menu.

`withTimeout` (`src/with-timeout.ts`) also wraps the worker calls behind our own providers.

### 3e. Custom TS worker (for the two missing providers)

New esbuild entry `webview/ts.worker.ts` replaces `monaco-editor/…/ts.worker.js` as the
`ts.worker` entry point:

```ts
import { initialize } from 'monaco-editor/esm/vs/editor/editor.worker';  // via monaco's own initialize
import { TypeScriptWorker, create } from 'monaco-editor/esm/vs/language/typescript/ts.worker';

class ConduitTsWorker extends TypeScriptWorker {
  async getTypeDefinitionAtPosition(fileName, position): Promise<ts.DefinitionInfo[] | undefined>
  async getImplementationAtPosition(fileName, position): Promise<ts.ImplementationLocation[] | undefined>
}
```

Both delegate straight to `this._languageService.*` (present in the bundled services, R6) and
guard on `fileNameIsLib`, mirroring the shape of the existing `getDefinitionAtPosition`.

Renderer registers the two providers with `monaco.languages.registerTypeDefinitionProvider` /
`registerImplementationProvider` for all four TS/JS language ids. The span→`Location` conversion
reuses the same on-demand model materialisation as Monaco's own adapters (public route:
`monaco.editor.getModel(uri) ?? createModel(typescriptDefaults.getExtraLibs()[fileName].content, …)`).

**Invariant:** results whose target file is neither a model nor an extraLib are dropped from the
result list, and if that empties the list the request reports `not-found` (or `not-ready` while
streaming) — never an empty silent success.

### 3f. Synchronous tokenizer registration

```ts
// webview/monaco-languages.ts
ensureTokenizer(languageId: string): void   // idempotent, synchronous, no await
```

A static map from language id to the already-bundled monarch module
(`monaco-editor/esm/vs/basic-languages/<lang>/<lang>.js`), registered via
`monaco.languages.setMonarchTokensProvider` + `setLanguageConfiguration`. An explicit
registration supersedes the lazy factory in `TokenizationRegistry`. Called by `CodeViewer`
**before** `monaco.editor.create`, and before `createModel`.

Because esbuild's iife bundle already inlines every one of those modules, this adds **zero
bytes**; it only removes an `await`.

### 3g. On-demand dependency types (v1)

When a navigation resolves to nothing *and* the symbol's origin is a bare module specifier, the
renderer asks the host to resolve that package's type entry point
(`node_modules/<pkg>` → `package.json#types|typings` → `index.d.ts`), pushes the returned files
as extraLibs, and **retries the request exactly once**. Bounded: one package per attempt, a hard
file-count/byte cap, no transitive crawl beyond the entry file's own imports.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Navigation invoked while the index is still streaming | Request runs against what's loaded. Empty result → **`not-ready`** message naming progress ("indexing 1,240 of 3,880"), with a Retry, not "no definition found". |
| Navigation invoked before any index exists (no project root, e.g. a loose file) | In-file resolution still works. Cross-file reports `not-ready` with "no project indexed". |
| Worker never settles | `withTimeout` fires at 6 s → `timed-out` state, indicator cleared, Retry offered. The indicator can never outlive the deadline. |
| Two navigations in flight | Existing ref-counted `gotoInflight` semantics kept: indicator stays until the **last** settles; each result navigates independently (last write wins for cursor). |
| Target file materialised from an extraLib gets language `typescript` even when it's `.tsx`/`.js` | On open, `CodeViewer` **must** `monaco.editor.setModelLanguage(model, doc.language)` before creating the editor, or JSX renders with the wrong grammar. Explicit acceptance criterion. |
| Target file was deleted/moved on disk since indexing | Host read fails → toast "File no longer exists", index entry dropped, no tab opened. |
| A file is both an open model and an extraLib | Model wins — `_getScriptText` checks mirror models before extraLibs, so the live buffer is what resolves. No de-dupe pass: `getScriptFileNames` may list the name twice, and TypeScript's program builder collapses duplicate root names by path. De-duping would mean re-pushing the whole extraLib map on every tab open and close. |
| File edited in Conduit and saved | Open file = live model, already correct. On save, its extraLib record is refreshed so background files resolving *into* it see the new content. |
| File changed on disk by an agent (the common case here) | Index entry goes stale. MVP: refresh on the existing file-change signal for files already indexed; a stale hit reveals a position that may be off by a few lines. Accepted and documented — not silently wrong content, because the tab itself always loads from disk. |
| Repo above the size threshold (see §5) | Priority wave still runs; full-project streaming stops at the cap, and the not-found path says "index capped at N files" instead of lying. |
| Two projects open in one window (multi-repo/multi-session) | ExtraLibs are a **union** keyed by absolute URI, so there are no collisions. Compiler options are per-worker and therefore **last-set wins** — switching the active project re-applies them and restarts the worker. Documented cost. |
| `tsconfig.json` malformed / absent | Fall back to today's hardcoded options. Never block indexing on a parse error; log it. |
| Browser preview (no `window.agentDeck`) | Bridge already stubs `projectFiles` with an empty list. Navigation degrades to in-file only; the flash fix and the command set are unaffected. |
| Memory | Source text is held twice (renderer extraLib map + worker copy), and again per open model. Same order as today's model-per-file, minus the model overhead. Capped by the index cap. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Index trigger | On project/session open, in the background | No | The first F12 must not race the index. Cost is off the interaction path by construction. |
| Index source | `git ls-files --cached --others --exclude-standard`, falling back to the bounded walk for non-git roots | No | Already implemented and TTL-cached in the host (`projectFileIndexMeta`); gitignore-aware and uncapped, which is exactly what R2 needs. |
| Index cap | 5000 source files (raised from an effective ~few-hundred after R2) | No | A memory backstop, not a policy. Exceeding it is reported honestly, not hidden. |
| Chunk size | 200 files per chunk | No | Tuned to keep per-chunk main-thread work under a frame; an implementation detail, not a preference. |
| Navigation deadline | 6 s | No | Long enough for a cold worker on a big repo, short enough that "hung" is impossible. |
| Eager tokenizer registration | Always on | No | It is strictly better and free. A toggle would be over-production. |
| Peek vs. jump for multi-result | Monaco's defaults (jump when unambiguous, peek/list when not) | No | Parity means matching VS Code's behavior, not inventing one. |
| Dependency `.d.ts` | Not indexed; fetched on demand (v1) | No (MVP) | Eager indexing multiplies program build time — the very thing being fixed. |

No new persisted settings. `settings.tsx` is untouched.

---

## 6. Scope slicing

**MVP (must)**
1. `registerEditorOpener` + delete the custom `agentdeck.goToDefinition`; adopt built-ins:
   `editor.action.revealDefinition` (F12), `editor.action.peekDefinition` (Alt+F12),
   `editor.action.goToReferences` (Shift+F12), `editor.action.referenceSearch.trigger`
   (Shift+Alt+F12).
2. Custom worker + providers for **Go to Type Definition** and **Go to Implementations**
   (Ctrl+F12), incl. their peek variants.
3. Context menu: navigation group in VS Code order, VS Code accelerators shown, correct
   enable/disable per language.
4. Index correctness + shape: git-ls-files source, chunked streaming, extraLibs instead of
   models, priority wave first, indexing starts at project open.
5. Project `tsconfig.json` compiler options (incl. `baseUrl`/`paths` → URI space).
6. Synchronous tokenizer registration — no unstyled frame.
7. Bounded requests + the `not-ready` / `timed-out` / `not-found` messages.
8. Rewrite the `CLAUDE.md` go-to-definition gotcha (R1) and the `INDEX_FILE_CAP` comment (R2).

**v1 (should)**
- On-demand dependency `.d.ts` fetch + single retry (§3g).
- `Find All References` as a *file*-scoped variant via `getFileReferences`.
- Index freshness on external file changes (agent writes) rather than on save only.
- Progress affordance for indexing (a quiet status, not a modal).

**Vision (could)**
- Call hierarchy (`prepareCallHierarchy` is available in the bundled services).
- Semantic token colouring (`getEncodedSemanticClassifications`).
- Rename Symbol / multi-file edits.
- Non-JS/TS language servers.

**Out of scope:** diagnostics, Go to Source Definition, formatting/refactor commands, split-editor
("Open Definition to the Side"), chat-related menu rows.

---

## 7. Acceptance criteria

### Declarative
- Right-clicking a symbol in a `.ts`/`.tsx`/`.js`/`.jsx` file offers **Go to Definition, Go to
  Type Definition, Go to Implementations, Go to References, Peek Definition, Find All
  References**, in that group, with the VS Code accelerators shown.
- Each of those commands navigates **into another file** and opens it as a Conduit tab with the
  cursor on the target, and the origin is reachable again via Alt+← / mouse-back.
- Opening a TypeScript file shows syntax colours on the **first rendered frame**; there is no
  frame in which the text is unstyled. Verified as *"the grammar is registered synchronously,
  before the model exists"* (`monaco.editor.tokenize` answers from the registry without
  resolving the lazy factory) rather than by watching the paint — the smoke harness runs the
  window hidden, which throttles rAF to ~1fps, so every render lands late regardless of
  whether the tokenizer was ready. See `test/e2e/editor-first-paint.e2e.mjs`.
- Go-to-definition on an import of a first-party module resolves without a perceptible wait on a
  warm session, and **never** leaves "Resolving definition…" on screen for more than the
  deadline.
- A repo whose tree contains more than 4000 non-source files still resolves definitions in its
  deep source directories (the R2 regression cannot recur).
- A repo using `paths`/`baseUrl` aliases resolves an aliased import.
- `npm run verify` is green; `ts.worker.js` is still emitted and the editor still loads.

### EARS
- *Ubiquitous:* The editor shall route all cross-file navigation through a single registered
  editor opener.
- *Event-driven:* When a project is opened, the system shall begin indexing its source files in
  the background, priority-ordering the open file and its direct imports.
- *Event-driven:* When a code file is opened, the system shall register its tokenizer
  synchronously before creating the editor, so the first paint is tokenized.
- *Event-driven:* When a navigation command resolves to a location in another file, the system
  shall open that file as a tab, reveal the position, and record the jump in navigation history.
- *State-driven:* While a navigation request is in flight, the system shall show the non-blocking
  resolving indicator and keep the editor interactive.
- *Unwanted:* If a navigation request exceeds the deadline, then the system shall abandon it,
  clear the indicator, and offer a retry.
- *Unwanted:* If a navigation returns no result while the index is incomplete, then the system
  shall report that indexing is still in progress rather than reporting no definition.
- *Unwanted:* If a navigation target resolves into a file with no content available, then the
  system shall drop that result and report not-found rather than opening an empty tab.
- *Where present:* Where the project has a readable `tsconfig.json`, the system shall apply its
  compiler options — including `baseUrl` and `paths` — before starting the language worker.

### Gherkin

```gherkin
Feature: Cross-file navigation parity

  Background:
    Given a TypeScript project is open in Conduit
    And its source files have been indexed

  Scenario: Go to Definition crosses files
    Given a file importing "StorefrontIdentityPort" from "./identity.consumer-port"
    When the user invokes Go to Definition on that imported symbol
    Then "identity.consumer-port.ts" opens as a tab
    And the cursor is on the declaration of "StorefrontIdentityPort"
    And pressing the back navigation returns to the importing file

  Scenario: Type Definition and Implementations
    Given the cursor is on a variable whose type is declared in another file
    When the user invokes Go to Type Definition
    Then the file declaring that type opens with the cursor on the declaration
    And invoking Go to Implementations on an interface lists its implementors

  Scenario: No unstyled frame on open
    When the user opens a TypeScript file
    Then the first rendered frame of the editor contains syntax-coloured tokens

  Scenario: A request can never hang
    Given the language worker does not respond
    When the user invokes Go to Definition
    Then the resolving indicator clears within the deadline
    And the user is told it could not be resolved and offered a retry

  Scenario: Honest answer while indexing
    Given the project index is still streaming
    When a navigation finds no result
    Then the user is told indexing is still in progress, with its progress
    And is not told that no definition exists

  Scenario: Deep source files are reachable
    Given a repo containing more than 4000 non-source files
    And a source file nested below them
    When the user invokes Go to Definition on a symbol defined in that file
    Then it resolves and opens
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Editor surface | opening | Tokenized text on the first frame; no unstyled flash | — |
| Nav indicator | idle | Nothing | — |
| Nav indicator | resolving | "Resolving definition…" status line (existing chrome), editor still usable | — |
| Nav result | navigated | New/focused tab, cursor on target, target line briefly emphasised | Back (Alt+←) |
| Nav result | multiple | Monaco peek / references widget, list focused | Enter opens, Esc dismisses |
| Nav result | not-found | Transient info toast: "No definition found." | — |
| Nav result | not-ready | Transient info toast: "Still indexing this project (N of M)." | Retry |
| Nav result | timed-out | Transient error toast: "Couldn't resolve in time." | Retry |
| Context menu item | disabled | Greyed nav rows on a non-TS/JS file | — |
| Index | streaming | Quiet progress affordance (v1); MVP surfaces it only via the not-ready message | — |

No blocking states. Nothing in this feature takes a modal.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Go to Definition | navigate | Ctrl/Cmd+Click on symbol | **F12** | n/a (desktop) | row 1 | menu `menuitem`; result announced by the opened tab |
| Peek Definition | inline peek | menu | **Alt+F12** | n/a | row 2 | Monaco peek widget owns its roles/focus |
| Go to Type Definition | navigate | menu | — (Monaco default: unbound) | n/a | row 3 | `menuitem` |
| Go to Implementations | navigate/peek | menu | **Ctrl+F12** | n/a | row 4 | `menuitem` |
| Go to References | peek list | menu | **Shift+F12** | n/a | row 5 | `menuitem` |
| Find All References | references widget | menu | **Shift+Alt+F12** | n/a | row 6 | widget owns roles |
| Nav indicator | none (read-only) | not clickable | not focusable | n/a | — | `role="status"` `aria-live="polite"` (existing) |
| Result toasts | dismiss / retry | click Retry | tab-reachable | n/a | — | `role="status"`; error variant `role="alert"` |

- Menu ordering follows the context-menu ADR (`docs/specs/archive/2026-06-23-context-menu-consistency.md`):
  Primary → Create → Edit → Reference → Destructive. The nav group is **Reference**, placed as its
  own separated group, ahead of Find/Command Palette.
- The app's `ContextMenu` has **no submenu support** (`webview/components/context-menu.tsx`), so
  VS Code's "Peek ▸" submenu is flattened into the same group (Peek Definition sits inline).
  Building submenus is out of scope here.
- Keybindings live in the existing shortcut registry so they obey the precedence rules already
  specified in `archive/2026-07-03-shortcut-precedence-and-editable-nav.md` — Monaco wins keys it
  binds, via the bubble-phase handler.

## 10. Accessibility & i18n

- **Focus:** navigating moves focus into the opened editor at the target position — that is the
  point of the command, and it matches VS Code. Peek widgets keep focus in the peek list until
  dismissed (Monaco's own behavior; not overridden).
- **Announcements:** the resolving indicator stays `role="status"` / `aria-live="polite"` (never
  `assertive` — it fires often). Terminal outcomes are announced once: not-found/not-ready as
  polite status, timed-out as `role="alert"` since it needs action.
- **Keyboard-only path is complete:** every command has either a VS Code accelerator or a
  Shift+F10 → context-menu route. No command is pointer-only.
- **Disabled rows are rendered disabled, not hidden**, so the menu's shape is stable between
  languages (consistent with `buildEditorMenuItems`' existing treatment of Go to Definition).
- **Contrast/motion:** the target-line emphasis after a jump uses an existing theme token and a
  fade, and is suppressed under `prefers-reduced-motion`.
- **i18n:** the app is English-only with literal strings throughout; new strings follow suit. All
  user-visible strings are short, plain, and free of jargon: "No definition found.", "Still
  indexing this project.", "Couldn't resolve in time." No string concatenation that would break
  under translation later beyond the existing pattern.

## 11. Design tokens

Semantic roles only — no raw hex anywhere (global rule).

- Nav indicator: existing `.viewer__loading` chrome, unchanged.
- Result toasts: existing toast variants (`info`, `error`).
- Target-line emphasis after a jump: reuse the current-line-highlight token family
  (`--code-line-highlight`) at a brief elevated alpha; no new colour.
- Peek/references widget: Monaco-owned. Its colours come from the `agentdeck` theme in
  `monaco-theme.ts`; **new theme colour keys will be needed** for `peekView*` /
  `editorWidget.*`, mapped to existing `--raise` / `--text` / `--line` tokens, or the widget
  renders in stock `vs-dark` and will look foreign in Paper. This is a real, easily-missed item —
  it is an MVP acceptance point, not a polish follow-up.
- All three themes stay on base `vs-dark` (the editor surface is ink on every theme, per
  `archive/2026-07-01-theme-correctness.md`).

---

## 12. Assumptions

- **A1** — Both `typescriptDefaults` and `javascriptDefaults` receive the same extraLib set, so
  navigation from `.js` behaves like `.ts`. Cost: a second worker holds a second copy, but only
  once a JS file is actually opened.
- **A2** — The index is scoped to a **session's project root**. A file opened from outside any
  indexed root gets in-file navigation only.
- **A3** — Index freshness in MVP is tied to saves and project (re)open. Full external-change
  tracking is v1. Rationale: agents rewriting files mid-session is common here, but a stale
  *index* only misplaces a jump by a few lines — the opened tab always shows real disk content.
- **A4** — "Go to Source Definition" is **omitted**, not stubbed or aliased. There is no
  `getSourceDefinitionAndBoundSpan` in the bundled services, and with no dependency `.d.ts`
  indexed there is nothing to source-map back from. A row that silently behaves like Go to
  Definition would be worse than its absence.
- **A5** — "Add Symbol to Chat" / "Jest: Run Related Tests" from the reference screenshot are
  Cursor/extension features, not VS Code core, and are not part of "parity" here. (Conduit's
  existing "Mention in terminal" already covers the send-a-symbol-to-the-agent job.)
- **A6** — Deleting the custom `agentdeck.goToDefinition` requires rewriting
  `test/e2e/goto-index.e2e.mjs`, which asserts on models created by `indexModels`; it becomes an
  assertion about extraLibs plus a real cross-file jump. The unit tests for
  `webview/monaco-warmup.ts` survive in reduced form (the in-flight tracker stays; the
  warm-by-poking-a-model helper is superseded by the priority wave).
- **A7** — Deep imports into `monaco-editor/esm/**` are permitted by its package `exports`
  (`"./*": "./*"`), but the ESM files ship **no type declarations**. The custom worker entry and
  the command service need small local `.d.ts` declarations (`types/monaco-internal.d.ts`,
  `types/monaco-basic-languages.d.ts`) — typed declarations, explicitly **not** an `as any` /
  `@ts-ignore` escape. Note esbuild resolves these through the package's exact `exports` map, so
  the specifiers must carry the `.js` extension even though tsc doesn't need it.

## 13. Open questions

- **Q1 (the one decision left) — the indexing shape.** You said you weren't sure and suggested
  preloading what's in view plus its imports. This spec resolves it as **one mechanism, ordered
  by need**: everything is pushed as extraLibs (cheap — no Monaco models, R4), with the open
  file's import closure in the first wave and the rest streamed behind it. That gives your
  instinct's latency without maintaining two code paths, and keeps *References* correct once
  streaming completes (a pure closure approach would silently under-report references — the
  reason not to do closure-only). Confirm, or say if you want the closure to be the *only* thing
  indexed and references explicitly marked "within loaded files".
- **Q2** — Index cap of 5000 source files: fine as a backstop, or should very large monorepos get
  a different story (e.g. index per-workspace-folder on demand)? Not blocking — the cap is
  reported honestly either way.
- **Q3** — Should Go to Type Definition get a keybinding? VS Code leaves it unbound by default;
  this spec follows suit. Say the word if you want one.

## 14. Self-audit

Template coverage walked: problem frame ✓ · behavior & states ✓ · data/interface contract ✓ ·
edge cases & failure modes ✓ · defaults vs settings ✓ · scope slicing ✓ · acceptance
(declarative + EARS + Gherkin) ✓ · state catalog ✓ · interaction inventory ✓ · accessibility &
i18n ✓ · design tokens ✓ · assumptions ✓ · open questions ✓. Root-cause section added beyond the
template because three findings reverse decisions currently recorded in `CLAUDE.md` and an
archived spec, and that reversal is the load-bearing part of the design.

Deliberately empty: **Decisions Needed** — interactive mode, so the four material choices were
put to the user up front (§0 R1, §6 command set, §3g dependency types, §2b index shape) and the
residue is in §13.

# Language servers in the host (Go via gopls): implementation plan

**Spec:** `docs/specs/2026-09-22-language-server-go.md`  **Tier:** FULL
**Revision 2:** folds in the 14 design-review findings (3 blockers). See "Review findings → where
fixed" at the end.

## Goal

F12, Ctrl+click, peek, references, hover and breadcrumbs work on `.go` tabs through the surfaces TS
already uses. They are answered by a user-installed gopls that the Electron host owns, spawns
safely, keeps in sync with the tabs, and never leaves orphaned. Nothing downstream of the registry
special-cases Go.

## Architecture

The host owns everything stateful: binary resolution, one process per server root, the doc sync
table, the lifecycle (idle, crash, ordered stop, quit), the file watcher, and URI⇄path conversion.
The renderer is a thin client. It learns *which languages have a server* from the host (the
registry, via `statusSnapshot.languages`), syncs open/change/close keyed on the **tab list**, sends
requests, and shows replies through the existing nav wrapper.

Every rule that can be pure lives in `src/`: URIs, root resolution and lexical mapping, binary
search order, child env, the watch-glob matcher, the restart budget, LSP→Conduit conversion, and
message/envelope validation. That makes all of it testable in node on ubuntu CI.

`electron/` has three process-facing units, each taking its collaborators as injected deps so the
fake-process/fake-clock tests need no Electron:
- `lsp-server`: one connection.
- `lsp-manager`: all servers, docs, clients and the lifecycle.
- `lsp-watcher`.

LSP navigation is **not a parallel nav path**. `runNavCommand` swaps only its *probe* for a language
with a server (`probeLspNav`). It then classifies, opens (`openLocation`) and peeks
(`dispatchLocations`) exactly as TS does. That is the seam feat/nav-history hooks.

## Data flow

```
renderer (webview/)                                   host (electron/)                         gopls
preload mints EPOCH once per page load; every lsp msg = {epoch, msg}
app.tsx effect on docState.docs + files + languages
  └─ lsp-sync.reconcileLspDocs(tabs) ─ lsp:open/close ─▶ ipcMain.handle('lsp')
model.onDidChangeContent ─ 150 ms debounce ─ lsp:change ─▶  LspManager.handle(webContentsId, raw)
                                                      │ parseLspEnvelope (trust boundary) → client (wc, epoch)
                                                      │   new epoch → retire old epoch's refs; retired epoch → reject
                                                      │ per-DOC intake chain (enqueued sync, before any await)
                                                      │ resolveServerRoot → key(realRoot) → server (lazy; `disposed` re-checked)
                                                      │ doc table {text, lspVersion, per-client {refs, version, text}}
                                                      │ not live → table only; live → didOpen/didChange/didClose ─▶ stdio JSON-RPC
runNavCommand (ts-nav.ts)                                                                           │
  hasLanguageServer? ─ flushPending ─ probeLspNav ─ lsp:request ─▶ chain → pending[requestId] ──────▶│
         ◀── LspReply (paths mapped realRoot→lexical root) ◀── lsp-convert ◀───────────────────────
  classifyNavOutcome → openLocation (1) / dispatchLocations (peek, models from `targets`)
hover provider ─ flushPending ─ lsp:request   ·   breadcrumb-bar ─ lsp:request (no flush, version-checked)
lsp-status store (servers + languages) ◀── 'lsp:status' push ◀── LspManager transitions
                                                      LspWatcher (recursive fs.watch per root, filter from spec.watchGlobs)
                                                        ├─ workspace/didChangeWatchedFiles ────────▶
                                                        └─ module/workspace marker → re-home docs
before-quit ─────────────────────────────────────────▶ manager.killAllSync(): disposed=true, timers cleared,
                                                        every live server killTreeSync (taskkill /T /F | kill(-pid))
```

## Settled decisions (do not re-litigate)

- **Trust (conductor ruling):** lazy auto-start on first Go tab open or first Go nav. It is mitigated by:
  - `GOTOOLCHAIN=local` (unless the user's env sets `GOTOOLCHAIN`);
  - **non-absolute `PATH` entries stripped from the child env** (ruling #14);
  - **no workspace-supplied config of any kind**.

  The per-root opt-in is a recorded alternative in ADR 0006 and is not built.
- **ADR 0006 is written in this build** as `docs/adr/0006-host-side-language-servers.md`, status
  **proposed**. It records trust (including the PATH strip), lifetime (ruling #13) and the Job-object
  contingency.
- **Lifetime (ruling #13):** a server lives while its root has at least one open tab of its language
  in any window. Sessions do **not** hold it. Idle stop is 60 s after the last such tab closes.
- **Genuinely generic (ruling #10):**
  - The watcher filter is derived from `spec.watchGlobs`.
  - The renderer asks "does this language have a server" (`hasLanguageServer`, from
    `statusSnapshot.languages`).
  - Every user-facing string is templated from the registry entry (`displayName`, `binary`,
    `installHint`, `moduleMarker`).
  - The palette entry is "Restart {displayName} language server".
  - No renderer file compares a language id to `'go'`.
- The spec's normal decisions take its defaults:
  - crash recovery is the palette command;
  - the watcher stays;
  - out-of-root targets open as normal writable tabs;
  - idle 60 s and loading wait 90 s;
  - hover links go through the existing external path.

  The stdin-EOF orphan assumption is now **tested** (T4.2 force-kill scenario).
- Deps: `vscode-jsonrpc` ^9.0.2 + `vscode-languageserver-protocol` ^3.18.3, **bundled** into
  `out/main.js` by esbuild. electron-builder excludes `node_modules/**` except `@lydell`
  (`package.json` `build.files`), so they must never be marked `external`.
- One server per `(languageId, realpath(root))`. The realpath is **only** the dedupe key. gopls gets
  the first-seen **lexical** root (doc-path spelling), and returned paths under the realpath are
  mapped back onto it. Root = highest `go.work` dir, else nearest `go.mod` dir, else the workspace
  root (ad hoc). Servers are process-global.
- Docs are ref-counted per **client** `(webContentsId, epoch)`. The epoch is a preload-minted
  per-page-load nonce, because `webContents.id` survives `reload()` (`electron/main.ts:1037`).
- Full-text sync with a 150 ms debounce. Nav requests **and hover** flush the tab's pending change
  first. Symbols never flush and are version-checked.
- **Requests are never gated on progress tokens.** A request is sent as soon as `initialize` has
  completed (and any restart replay has finished). Its timeout is picked by the state at send time:
  - `loading`: 90 s total budget for nav;
  - `ready`: 10 s nav, 3 s hover, 5 s symbols;
  - `starting`/`restarting`: the wait for `initialize` counts against the 90 s (nav) or 3 s
    (hover/symbols, which then return empty).

  Other constants: restart 1/4/16 s, ≤ 3 per rolling 5 min; absent verdict cached 30 s; out-of-root
  origin LRU 2 000; targets ≤ 200 files, ≤ 2 MB each.
- **Current vs stale (finding #3):** a request is current when its version is its client's last
  accepted version **and** that client's last accepted text equals the host's current text.
- **Ordered stops are not crashes (finding #1):**
  - Every host-initiated stop (idle, restart command, re-home, quit) sets the server record's
    `stopping` flag before stopping, and `onExit` of a stopping server never restarts.
  - `killAllSync` sets the manager-wide `disposed` flag **first** and clears every restart and idle
    timer.
  - Every async step re-checks `disposed` after each `await` before `startServer`.
- **Restart replay (finding #5):** `didOpen` for every table doc of the key is sent **before** the
  state leaves `restarting`/`starting`. Requests wait for it. While a server is not live,
  open/change/close only update the table.
- Graceful stop = `shutdown` → on reply or after 2 s → PID-scoped tree kill. **No `exit`
  notification** (finding #12). Quit = synchronous tree kill only. Never kill by image name.
- Messages are the spec's §3.3 templates. An LSP `none` never appends TS index notes. Ctrl+click is
  silent on absent/crashed/no-root. Nav toasts are deduped by text while one is visible.
- The renderer never sees a server URI. The host converts every URI to a canonical path.

**Plan-level decisions** (made here; the spec left them open or placed them differently):

- **Sync is keyed on the tab list, not on CodeViewer mount.** Only the active doc mounts
  (`webview/components/center-pane.tsx:357`, `key={activeDoc.id}`). The owner is `webview/app.tsx`,
  which already derives the open file-path set (`app.tsx:1066-1075`).
- **Doc text rule:** if a model exists and the path is dirty, `text = model.getValue()`; otherwise
  `text = files.get(path)?.content ?? model?.getValue()`. A tab whose content hasn't loaded is not
  opened until it has.
- **Ordering is a per-document intake chain**, not a per-server queue. Root resolution is async, so a
  per-server queue can't be chosen synchronously. Only the *send* step is chained; the reply wait is
  not.
- **Every request has a pending handle** (`requestId → { abort(reason) }`) from arrival until reply,
  so `lsp:cancel` works both while waiting for `initialize`/replay and after the request reached
  gopls (then it also sends `$/cancelRequest`) (finding #8).
- **Epoch transport:** the preload wraps `{ epoch, msg }`. `epoch` is `globalThis.crypto.randomUUID()`
  evaluated once at preload load; the preload is sandboxed, and web crypto is available there. The
  renderer never sees or supplies it.
- **Invoke-channel types live in `src/lsp-protocol.ts`**, following the `src/git-actions.ts`
  precedent. `src/protocol.ts` gains only the `lsp:status` push.
- **E7's PID source is `lsp:statusSnapshot`** (`pid` in each status). The force-kill scenario takes
  the Electron main PID from Playwright's `app.process().pid`.
- **Missing-gopls e2e mechanism:** launch with:
  - `PATH=%SystemRoot%\System32;%SystemRoot%`
  - `GOPATH=<empty temp>`
  - `GOBIN=''`
  - `USERPROFILE=HOME=<empty temp>`

  `go` still resolves from `C:\Program Files\Go\bin`, and `go env GOPATH` reports the empty dir.
- **Windows binary candidates are `<dir>\gopls.exe` only.** Node refuses to spawn `.cmd`/`.bat` with
  `shell:false` (CVE-2024-27980 fix), and the spec forbids a shell.
- **Nav-guard origin (finding #9):** the guard records the caret position at `runNavCommand` entry.
  A cursor event cancels only if the new position differs from that origin.
- **Watch-glob support:** `compileWatchGlobs` supports exactly `**/*.<ext>` and `**/<basename>`.
  `GO_SERVER`'s globs are only those shapes. A registry test asserts every entry's globs parse, so a
  future server can't ship an unsupported glob silently.

## Spec staleness

- §2.1.1 "Tab mount → `lsp:open`". Measured: only the active doc's `CodeViewer` is mounted
  (`webview/components/center-pane.tsx:357`). Plan: sync is keyed on `docState.docs` in `app.tsx`.
- §3.4 "plus each `PATHEXT` ext on Windows". `.cmd`/`.bat` cannot be spawned without a shell. Plan:
  `.exe` only.
- §3.1 `extraSearchDirs(): Promise<string[]>` / `childEnv(base, resolvedGoDir)`. Taking no argument
  makes them impure and untestable on CI. Plan: both take an injected `SearchContext`, and the `go`
  lookup is `resolveToolDir`.
- The worktree base `57c1418` is behind `main` (`13e0681`). The builder merges `main` and
  `feat/go-basics` into `feat/go-lsp` before Slice 1.
- Revision 2 also corrected the spec itself (same commit): lifetime, epoch, stale rule, lexical root,
  replay, ordered stops, no-`exit` stop, progress gating, hover flush, generic copy, PATH strip,
  force-kill e2e, palette slice. See Review findings.

## Global constraints

- **Gate:** `npm run verify`. Capture exit codes directly, never through a pipe or `| tail`.
- **Two tsconfigs:** typecheck runs both. **No `webview/` file may import `src/lsp-convert.ts`,
  `src/lsp-binary.ts`, `src/lsp-registry.ts` or any `vscode-*` package**, and `src/lsp-protocol.ts`
  stays free of them.
- **Stack:**
  - Electron 43.3.0.
  - TypeScript 7.0.2, with `module: CommonJS` for the host tsconfig.
  - vitest 4: `test/unit/**/*.test.ts`, node env, `// @vitest-environment jsdom` on line 1 for DOM.
  - Biome 2.5.7.
  - fallow 3.14: unlisted/unused deps and dead exports gate; duplication does not.
- **CI is ubuntu.** No pure `src/` module reads `process.platform`, default `path`, or `os`. Platform
  is a parameter, and joins use `path.win32`/`path.posix`. Windows cases are unit-tested.
- **Naming and layout:**
  - kebab-case files;
  - `electron/<unit>.ts` flat;
  - `src/<topic>.ts` pure;
  - tests in `test/unit/<module>.test.ts`;
  - e2e in `test/e2e/<name>.e2e.mjs` on the harness, run alone with
    `node test/e2e/run-smoke.mjs go-lsp`, hidden, never fanned out.

  A PTY-looking failure is re-run alone on a quiet machine before anyone believes it.
- **Comments** explain *why* only. Rationale in the spec or ADR 0006 gets a one-line pointer.
- **Spawn security:** `shell:false`, absolute `realpath`'d binary, `cwd` = server root,
  `windowsHide:true`, and `taskkill` by absolute path. No `.conduit/*`, `.vscode/*`, `go.work` or env
  file chooses a binary, args or env.
- **`node_modules` is a junction to the main checkout.** `npm install` here adds there too, which is
  expected. Never run `npm ci`/`npm prune` from this worktree.
- **Commits:** do **not** touch `CHANGELOG.md`. Commit per slice on `feat/go-lsp` with
  `feat(lsp): …` / `test(lsp): …` / `docs(adr): …`, each ending with the session's `Co-Authored-By`
  line. Run `git status` before every commit. Scratch goes to `%TEMP%\claude-scratch\`.

## Sibling overlap (rebase map)

| File | This plan | feat/go-basics | feat/nav-history |
|---|---|---|---|
| `webview/nav-outcome.ts` | `lsp-*` outcomes carrying `LspLanguageInfo`, `none.adHocMarker`, `index: … \| null`, `cancelled` | `unsupported` gains `languageId`, new copy | — |
| `test/unit/nav-outcome.test.ts` | new cases | updates the unsupported assertion | — |
| `webview/ts-nav.ts` | LSP probe branch in `runNavCommand`; `hasCodeNavigation`; `NavDeps.gesture` | passes `languageId` into `unsupported` | `openDefinitionFile(abs, pos)` at `:150`, `:171`, `:412-413` (inside `openLocation`) |
| `webview/project-index.ts` | `canonicalPath` moves out (lines 3-21) | — | `setDefinitionOpener`/`openDefinitionFile` signature |
| `webview/components/code-viewer.tsx` | Ctrl+click and menu gate → `hasCodeNavigation`; `gesture:'pointer'`; `canonicalPath` import | — | cursor-jump listener near `:384` |
| `webview/components/breadcrumb-bar.tsx` | server-language symbol source | — | symbol jump `:185-187` → `openDefinitionFile(path,pos)` |
| `webview/app.tsx` | reconcile effect, `initLspClient`, hover registration, palette entries, `canonicalPath` import | — | opener registration `~1615-1629` |
| `src/lang.ts`, `src/file-icon.ts`, `webview/monaco-languages.ts` | **not touched** | owns | — |

go-basics merges in before Slice 1, so `unsupported` already carries `languageId`. No new code calls
`openDefinitionFile`/`setReveal`. Every landing goes through `openLocation` or the unchanged
breadcrumb jump, so nav-history's edits cover LSP languages without change.

## Out of scope

- Spec §1 non-goals.
- A persistent status chip.
- Read-only tabs.
- `src/lang.ts`, `src/file-icon.ts`, `webview/monaco-languages.ts` (go-basics).
- `CHANGELOG.md`.
- A Windows Job object: out of scope **unless** the T4.2 force-kill scenario fails. Then the build
  stops and the conductor re-plans it (see Decisions Needed).

## Contracts

### `src/canonical-path.ts` (moved verbatim from `webview/project-index.ts:3-21`)
```ts
export function canonicalPath(path: string): string;
```

### `src/lsp-uri.ts` (pure, platform-independent)
```ts
/** `G:\x`, `g:/x` → `file:///G:/x`; `/x` → `file:///x`; UNC `\\srv\share\x` → `file://srv/share/x`.
 *  Segments percent-encoded (encodeURIComponent; drive colon literal). */
export function pathToFileUri(path: string): string;
/** Accepts `file:///c%3A/…`, `file:///C:/…`, `file:///c:/…`, `file://srv/share/…` → canonicalPath
 *  spelling; null for any non-`file:` URI. */
export function fileUriToPath(uri: string): string | null;
```

### `src/lsp-protocol.ts` (renderer-safe: imports only `./breadcrumbs` types)
```ts
import type { NavTreeNode } from './breadcrumbs';
export type LspServerState = 'absent' | 'starting' | 'loading' | 'ready' | 'restarting' | 'crashed' | 'stopped';
export type LspDocState = LspServerState | 'no-root';
export type LspOp = 'definition' | 'typeDefinition' | 'implementation' | 'references' | 'hover' | 'documentSymbol';
export interface LspPosition { line: number; character: number }           // 0-based, UTF-16
export interface LspRange { start: LspPosition; end: LspPosition }
export type LspUnavailableReason = 'missing' | 'crashed' | 'no-root' | 'loading-timeout' | 'timeout' | 'server-error';
export type LspReply =
  | { kind: 'locations'; locations: { path: string; range: LspRange }[]; targets: { path: string; text: string }[]; dropped: number }
  | { kind: 'hover'; markdown: string; range?: LspRange }
  | { kind: 'symbols'; tree: NavTreeNode }
  | { kind: 'empty'; adHocRoot: boolean }
  | { kind: 'stale' }
  | { kind: 'unavailable'; reason: LspUnavailableReason; detail?: string };
export interface LspServerStatus { serverKey: string; languageId: string; root: string; state: LspServerState; progress?: string; pid: number | null }
/** What the renderer may know about a registry entry — all user-facing copy is templated from it. */
export interface LspLanguageInfo { languageId: string; displayName: string; binary: string; installHint: string; moduleMarker: string }
export interface LspCalls {
  'lsp:open': { req: { path: string; languageId: string; version: number; text: string }; res: { serverKey: string | null; state: LspDocState } };
  'lsp:change': { req: { path: string; version: number; text: string }; res: { ok: boolean } };
  'lsp:close': { req: { path: string }; res: { ok: boolean } };
  'lsp:request': { req: { requestId: string; path: string; version: number; op: LspOp; line: number; character: number }; res: LspReply };
  'lsp:cancel': { req: { requestId: string }; res: { ok: boolean } };
  'lsp:statusSnapshot': { req: Record<string, never>; res: { servers: LspServerStatus[]; languages: LspLanguageInfo[] } };
  'lsp:restart': { req: { languageId: string }; res: { ok: boolean } };
}
export type LspCallType = keyof LspCalls;
export type LspMessage<K extends LspCallType = LspCallType> = K extends LspCallType ? { type: K } & LspCalls[K]['req'] : never;
export type LspResult<K extends LspCallType> = LspCalls[K]['res'];
/** What the preload actually sends over 'lsp'. */
export interface LspEnvelope { epoch: string; msg: LspMessage }
/** Trust boundary. Null unless: known `type`; `path` non-empty absolute (POSIX `/`, drive `X:\`/`X:/`,
 *  UNC `\\`); `languageId` non-empty ≤ 32; `version`/`line`/`character` safe ints ≥ 0; `text` string;
 *  `requestId` non-empty ≤ 64; `op` in LspOp. */
export function parseLspMessage(raw: unknown): LspMessage | null;
/** `{epoch: non-empty string ≤ 64, msg: parseLspMessage-valid}` or null. */
export function parseLspEnvelope(raw: unknown): LspEnvelope | null;
```
`src/protocol.ts` `HostToWebview` gains `| { type: 'lsp:status'; status: LspServerStatus }`.

### `src/lsp-binary.ts` + `src/lsp-registry.ts` (pure; all I/O injected)
```ts
// lsp-binary.ts
export type HostPlatform = 'win32' | 'darwin' | 'linux';
export interface SearchContext {
  env: Readonly<Record<string, string | undefined>>; platform: HostPlatform; homedir: string; tmpdir: string;
  isFile(p: string): Promise<boolean>; realpath(p: string): Promise<string>;
  execFile(file: string, args: readonly string[], opts: { cwd: string; env: Record<string, string | undefined>; timeout: number }): Promise<string>;
}
/** Absolute, non-empty PATH entries (`;` win32 / `:` else; key matched case-insensitively on win32). */
export function pathDirs(ctx: Pick<SearchContext, 'env' | 'platform'>): string[];
/** First `<dir>/<name>` (win32 `<dir>\<name>.exe`) that isFile, realpath'd; null if none. */
export function findBinary(name: string, dirs: readonly string[], ctx: SearchContext): Promise<string | null>;
export interface ResolvedServer { binary: string; toolDir: string | null }
/** toolDir = spec.resolveToolDir(ctx); dirs = pathDirs ++ spec.extraSearchDirs(ctx, toolDir); findBinary. */
export function resolveServerBinary(spec: LanguageServerSpec, ctx: SearchContext): Promise<ResolvedServer | null>;

// lsp-registry.ts
export interface LanguageServerSpec {
  languageId: string; displayName: string; binary: string; args: readonly string[];
  rootMarkers: { workspace: readonly string[]; module: readonly string[] };
  watchGlobs: readonly string[]; installHint: string;
  resolveToolDir(ctx: SearchContext): Promise<string | null>;   // PATH, then GO_FIXED_DIRS[platform]
  /** $GOBIN; each $GOPATH entry + bin; `go env GOPATH` + bin (only with toolDir; cwd ctx.tmpdir,
   *  GOTOOLCHAIN=local, timeout 5 000); homedir/go/bin. Empty values skipped. */
  extraSearchDirs(ctx: SearchContext, toolDir: string | null): Promise<string[]>;
  /** Copy of base: PATH (existing key casing kept on win32) = [toolDir, ...absolute entries of base PATH]
   *  — NON-ABSOLUTE ENTRIES DROPPED (ADR 0006 §Trust); GOTOOLCHAIN='local' unless base.GOTOOLCHAIN non-empty. */
  childEnv(base: Readonly<Record<string, string | undefined>>, toolDir: string | null, platform: HostPlatform): Record<string, string | undefined>;
}
export const GO_FIXED_DIRS: Readonly<Record<HostPlatform, readonly string[]>>; // darwin /usr/local/go/bin,/opt/homebrew/bin; linux /usr/local/go/bin; win32 C:\Program Files\Go\bin
export const GO_SERVER: LanguageServerSpec;   // 'go','Go','gopls',[],{['go.work'],['go.mod']},['**/*.go','**/go.mod','**/go.sum','**/go.work'],'go install golang.org/x/tools/gopls@latest'
export const LANGUAGE_SERVERS: readonly LanguageServerSpec[];   // [GO_SERVER]
export function serverSpecFor(languageId: string): LanguageServerSpec | null;
/** {languageId, displayName, binary, installHint, moduleMarker: rootMarkers.module[0] ?? ''} */
export function languageInfo(spec: LanguageServerSpec): LspLanguageInfo;
/** Supports exactly `**\/*.<ext>` and `**\/<basename>`; throws on any other shape (registry test catches it). */
export function compileWatchGlobs(globs: readonly string[]): (relPath: string) => boolean;
/** Basename is one of rootMarkers.workspace ∪ rootMarkers.module. */
export function isRootMarker(spec: Pick<LanguageServerSpec, 'rootMarkers'>, relPath: string): boolean;
```

### `src/lsp-root.ts` (pure)
```ts
export interface RootProbe { exists(p: string): Promise<boolean>; realpath(p: string): Promise<string> }
export interface ServerRoot {
  key: string;            // serverKeyFor(languageId, realRoot) — dedupe only
  realRoot: string;       // canonicalPath(realpath(lexicalRoot))
  root: string;           // lexical root in the DOC-PATH spelling (what gopls is given)
  workspaceRoot: string; adHoc: boolean;
}
/** Deepest workspace root containing filePath (case-insensitive on win32); walk up: highest workspace
 *  marker dir, else nearest module marker dir, else the workspace root (adHoc). Null outside every root. */
export function resolveServerRoot(filePath: string, workspaceRoots: readonly string[], spec: Pick<LanguageServerSpec, 'languageId' | 'rootMarkers'>, probe: RootProbe, platform: HostPlatform): Promise<ServerRoot | null>;
export function serverKeyFor(languageId: string, realRoot: string): string;   // `${languageId}:${realRoot}`
export function isWithin(child: string, parent: string, platform: HostPlatform): boolean;
/** path under realRoot (and realRoot ≠ lexicalRoot) → same relative path under lexicalRoot; else unchanged. */
export function toLexicalPath(path: string, realRoot: string, lexicalRoot: string, platform: HostPlatform): string;
```

### `src/lsp-restart-budget.ts` (pure)
```ts
export const RESTART_DELAYS_MS: readonly [1000, 4000, 16000];
export const RESTART_WINDOW_MS = 300_000;
export function nextRestart(history: readonly number[], now: number): { delayMs: number; history: number[] } | null;
```

### `src/lsp-convert.ts` (host only; types from `vscode-languageserver-protocol`)
```ts
export function toLocations(result: Location | Location[] | LocationLink[] | null | undefined): { path: string; range: LspRange }[];
export function toHover(h: Hover | null | undefined): { markdown: string; range?: LspRange } | null;
export function toNavTree(symbols: DocumentSymbol[] | SymbolInformation[] | null | undefined, text: string, fileName: string): NavTreeNode;
export function offsetAt(text: string, pos: LspPosition): number;
export function symbolKindName(kind: number): string;
```
The `symbolKindName` map:

| LSP `SymbolKind` | Name |
|---|---|
| Class 5, Struct 23 | `class` |
| Method 6, Constructor 9 | `method` |
| Property 7, Field 8 | `property` |
| Enum 10 | `enum` |
| Interface 11 | `interface` |
| Function 12 | `function` |
| Variable 13 | `variable` |
| Constant 14 | `const` |
| EnumMember 22 | `enum member` |
| TypeParameter 26 | `type parameter` |
| anything else | `''` |

### `electron/process-tree.ts`
```ts
export interface TreeKillDeps { platform: NodeJS.Platform; systemRoot: string; execFile: typeof import('node:child_process').execFile; execFileSync: typeof import('node:child_process').execFileSync; kill: (pid: number, signal: NodeJS.Signals) => void }
export function killTree(pid: number, deps: TreeKillDeps): Promise<boolean>;    // win32 taskkill.exe /PID p /T /F; posix kill(-pid,'SIGKILL'); never rejects
export function killTreeSync(pid: number, deps: TreeKillDeps): boolean;
export function defaultTreeKillDeps(): TreeKillDeps;
```

### `electron/lsp-server.ts`
```ts
export interface ChildLike extends NodeJS.EventEmitter { pid?: number; stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }
export type SpawnFn = (file: string, args: readonly string[], opts: { cwd: string; env: Record<string, string | undefined>; shell: false; windowsHide: true; stdio: 'pipe'; detached: boolean }) => ChildLike;
export type LspLog = Pick<Logger, 'info' | 'warn' | 'error'>;
export interface StartServerOptions { spec: LanguageServerSpec; binary: string; toolDir: string | null; root: string; hostEnv: Record<string, string | undefined>; platform: HostPlatform; spawn: SpawnFn; tree: TreeKillDeps; log: LspLog }
export class LspRequestError extends Error { constructor(readonly reason: 'timeout' | 'server-error' | 'cancelled', detail?: string) }
export interface LspServerHandle {
  readonly pid: number | null;
  readonly initialized: Promise<void>;   // initialize → initialized sent; rejects (server-error) on error or early exit
  readonly loading: boolean;             // any $/progress begin token open — used ONLY to pick timeouts/state
  onProgress(cb: (loading: boolean, title: string | undefined) => void): void;
  onExit(cb: (e: { code: number | null; signal: string | null; stderrTail: string[] }) => void): void;
  notify(method: string, params: unknown): void;
  /** Sends immediately; rejects LspRequestError. The signal aborts → $/cancelRequest + reject('cancelled'). */
  request<R>(method: string, params: unknown, opts: { timeoutMs: number; signal: AbortSignal }): Promise<R>;
  stop(): Promise<void>;    // shutdown → (reply | 2 s) → killTree. NO `exit` notification.
  killSync(): void;
}
export function startLanguageServer(opts: StartServerOptions): LspServerHandle;
```
The spawn call is exactly:

```ts
spawn(binary, spec.args, {
  cwd: root,
  env: spec.childEnv(hostEnv, toolDir, platform),
  shell: false,
  windowsHide: true,
  stdio: 'pipe',
  detached: platform !== 'win32',
})
```

`root` is the **lexical** root.

`initialize` params:
- `processId: process.pid`;
- `rootUri` and `workspaceFolders` from `pathToFileUri(root)`;
- `clientInfo {name:'Conduit'}`;
- `general.positionEncodings ['utf-16']`;
- capabilities:
  - definition, typeDefinition and implementation with `linkSupport:true`;
  - references;
  - hover `contentFormat ['markdown','plaintext']`;
  - documentSymbol `hierarchicalDocumentSymbolSupport:true`;
  - `window.workDoneProgress:true`;
  - `workspace.didChangeWatchedFiles {dynamicRegistration:false}`;
  - `workspace.configuration:true`;
  - `workspace.workspaceFolders:true`.

Server→client requests:
- `workspace/configuration` → one `null` per item;
- `window/workDoneProgress/create` and `client/registerCapability` → `null`;
- anything else → `MethodNotFound`.

`showMessage`/`logMessage` are logged, and `publishDiagnostics` is dropped. stderr keeps a 50-line
ring.

### `electron/lsp-watcher.ts`
```ts
export interface WatchedChange { path: string; type: 1 | 2 | 3 }   // Created | Changed | Deleted
export interface LspWatcherHandle { close(): void }
/** Recursive fs.watch; drops shouldIgnoreWatchPath(rel) and rels where !matches(rel); coalesces 200 ms;
 *  type: missing → 3, 'rename'+exists → 1, else 2; onMarker once per batch holding isMarker(rel). */
export function watchServerRoot(root: string, filter: { matches: (rel: string) => boolean; isMarker: (rel: string) => boolean }, onChanges: (c: WatchedChange[]) => void, onMarker: () => void, deps?: { watch?: typeof import('node:fs').watch; stat?: (p: string) => Promise<boolean>; log?: (m: string) => void }): LspWatcherHandle;
```
`filter` comes from `compileWatchGlobs(spec.watchGlobs)` and `isRootMarker(spec, rel)`. The watcher
knows no language.

### `electron/lsp-manager.ts`
```ts
export interface LspManagerDeps {
  registry: readonly LanguageServerSpec[];
  platform: HostPlatform;
  workspaceRoots(): string[];                       // main.ts writeRoots
  resolveBinary(spec: LanguageServerSpec): Promise<ResolvedServer | null>;
  resolveRoot(path: string, spec: LanguageServerSpec): Promise<ServerRoot | null>;
  startServer(o: { spec: LanguageServerSpec; resolved: ResolvedServer; root: string }): LspServerHandle;
  watchRoot(root: string, spec: LanguageServerSpec, onChanges: (c: WatchedChange[]) => void, onMarker: () => void): LspWatcherHandle;
  readTarget(path: string): Promise<string | null>; // null if > 2 MB, unreadable, or not a regular file
  broadcastStatus(s: LspServerStatus): void;
  log: LspLog;
}
export const IDLE_GRACE_MS = 60_000, ABSENT_TTL_MS = 30_000, NAV_TIMEOUT_MS = 10_000, NAV_LOADING_TIMEOUT_MS = 90_000,
  HOVER_TIMEOUT_MS = 3_000, SYMBOLS_TIMEOUT_MS = 5_000, INIT_WAIT_SHORT_MS = 3_000, ORIGIN_LRU_MAX = 2_000, TARGETS_MAX = 200;
export class LspManager {
  constructor(deps: LspManagerDeps);
  /** parseLspEnvelope; invalid or retired-epoch → per-type failure ({ok:false} / unavailable:server-error /
   *  {serverKey:null,state:'no-root'} / {servers:[],languages:[]}). Enqueues on the doc's chain synchronously. */
  handle(webContentsId: number, raw: unknown): Promise<LspResult<LspCallType>>;
  dropWebContents(webContentsId: number): void;     // every epoch of it
  statuses(): LspServerStatus[];
  killAllSync(): void;                              // disposed=true FIRST, clear timers, killSync every live server
}
```
Invariants. Each is a named unit test in T3.2.

**Clients (finding #2).**
- A client is `${webContentsId}:${epoch}`.
- The manager keeps `currentEpoch: Map<webContentsId, string>` and `retired: Set<clientKey>`.
- A message with a new epoch for a `webContentsId` does three things: it retires the current epoch;
  it drops every ref that epoch held (sending `didClose` where refs reach 0); and it adopts the new
  epoch.
- A message whose client is retired is rejected with its type's failure and changes nothing.
- `dropWebContents` retires all of that webContents' epochs.

**Doc table.**
- The table is `Map<path, { languageId; text; lspVersion; serverKey | null; clients: Map<clientKey, { refs; version; text }> }>`.
- `didOpen` is sent when the first client ref arrives; `didClose` when the total refs reach 0.
- `lspVersion` increments on every accepted change from any client.

**Current vs stale (finding #3).**
- A request is current iff its `version === clients.get(c).version` **and**
  `clients.get(c).text === doc.text`.
- Otherwise the reply is `{kind:'stale'}`.
- A path that isn't in the table gets `{kind:'empty', adHocRoot:false}`.

**Key resolution (finding #4).**
- `resolveRoot` runs first; if it gives nothing, the origin LRU is used; if that gives nothing, the
  doc is recorded with `serverKey:null` and requests get `unavailable/no-root`.
- The server record keeps `lexicalRoot` (the first `ServerRoot.root` seen for the key) and
  `realRoot`.
- Every path in a reply (locations, targets) goes through
  `toLexicalPath(p, realRoot, lexicalRoot, platform)` before the LRU and the renderer see it.

**Liveness (finding #5).**
- A server is *live* once `initialized` has resolved **and** its replay has finished.
- The replay is `didOpen` for every table doc of the key, with current text and `lspVersion`, sent
  in table order.
- The state becomes `loading`/`ready` (from `handle.loading`) only after the replay.
- While a server isn't live, open/change/close update the table only (no notify).
- Requests await liveness, bounded by their budget.

**Requests (finding #8).**
- On arrival a request gets a pending entry `requestId → AbortController`.
- Liveness wait: nav 90 s total; hover/symbols 3 s, then `empty`.
- Once live it is sent immediately. It is never held on progress.
- Timeout by state at send time:
  - `loading`: the remaining 90 s budget for nav;
  - `ready`: 10 s nav, 3 s hover, 5 s symbols.
- `lsp:cancel` aborts the entry in either phase (in phase 2 that sends `$/cancelRequest`). A
  cancelled request replies `{kind:'empty', adHocRoot:false}`.
- Replies by outcome:

  | Outcome | Reply |
  |---|---|
  | `crashed` | `unavailable/crashed` |
  | `absent` | `unavailable/missing` |
  | nav budget expired | `unavailable/loading-timeout` |
  | `LspRequestError('timeout')` | `unavailable/timeout` |

**Absent.**
- `resolveBinary` null → state `absent`, cached 30 s.
- Docs stay in the table. The re-probe after the TTL starts the server, and the replay sends them.

**Lifetime (ruling #13).**
- When a key's docs have 0 total refs, a 60 s idle timer is armed.
- Any open or request for the key clears it.
- When it fires: `stopping=true`, `stop()`, then state `stopped` and the watcher closed.
- There is no session input.

**Crash (finding #1).**
- `onExit` of a record with `stopping` → no restart; state `stopped` unless it was already
  broadcast.
- Otherwise, `disposed` → ignore.
- Otherwise `nextRestart`: a delay means state `restarting`, then start again (re-checking
  `disposed` after the delay and after `resolveBinary`), then the replay. `null`, or an
  `initialize` failure, means state `crashed`.
- Pending requests of a dead server reject → `unavailable/server-error`.

**Disposed (finding #1).**
- `killAllSync` sets `disposed` first, clears every idle and restart timer, and calls `killSync` on
  every live handle.
- Every `await` in the open/restart path (`resolveRoot`, `resolveBinary`) is followed by
  `if (disposed) return <typed failure>`, before `startServer`.

**Re-home.**
- `onMarker` recomputes keys for that server's docs.
- A moved doc gets `didClose` on the old key (only if live) and `didOpen` on the new one (lazy
  start, replay).
- The old key goes through the lifetime rule.

**Restart command.**
- Every server of the language: `stopping=true`, `stop()`.
- Restart histories and the absent cache are cleared, and `stopped` is broadcast.

**Status.** Every transition calls `broadcastStatus` (with `pid`).

### Renderer
```ts
// electron/preload.ts
const LSP_EPOCH = globalThis.crypto.randomUUID();   // once per page load
api.lsp = (msg: LspMessage) => ipcRenderer.invoke('lsp', { epoch: LSP_EPOCH, msg });

// webview/bridge.ts
export function lspInvoke<K extends LspCallType>(msg: LspMessage<K>): Promise<LspResult<K>>;
// fake: open → {serverKey:null,state:'absent'}; request → {kind:'unavailable',reason:'missing'};
//       statusSnapshot → {servers:[],languages:[]}; others → {ok:true}

// webview/lsp-status.ts
export function applyLspStatus(s: LspServerStatus): void;               // 'stopped' removes the entry
export function seedLspState(snapshot: { servers: readonly LspServerStatus[]; languages: readonly LspLanguageInfo[] }): void;
export function lspStateForKey(serverKey: string | null): LspDocState | null;
export function lspLanguage(languageId: string): LspLanguageInfo | null;
export function hasLanguageServer(languageId: string): boolean;         // lspLanguage(id) !== null
export function subscribeLspStatus(cb: () => void): () => void;
export function useLspStatuses(): readonly LspServerStatus[];
export function useLspLanguages(): readonly LspLanguageInfo[];
/** Languages that currently have a server entry in a state ≠ 'stopped' (incl. absent / crashed). */
export function restartableLanguages(statuses: readonly LspServerStatus[], languages: readonly LspLanguageInfo[]): LspLanguageInfo[];

// webview/lsp-sync.ts
export interface LspDocInput { path: string; languageId: string; text: string }
export const LSP_CHANGE_DEBOUNCE_MS = 150;
export function initLspClient(): () => void;   // statusSnapshot → seedLspState; subscribe 'lsp:status'; onDidCreateModel attach
export function reconcileLspDocs(docs: readonly LspDocInput[]): void;
export function isLspDocOpen(path: string): boolean;
export function serverKeyForDoc(path: string): string | null;
export function flushPending(path: string): Promise<void>;
export function currentVersion(path: string): number | null;          // last SENT version
export function subscribeLspDocSent(cb: (path: string) => void): () => void;
export function lspRequest(path: string, op: LspOp, pos: LspPosition, requestId: string): Promise<LspReply>;

// webview/lsp-nav.ts
export interface LspNavProbe {
  locations: monaco.languages.Location[]; timedOut: boolean;
  unavailable: 'missing' | 'crashed' | 'no-root' | 'loading-timeout' | null; adHocRoot: boolean; cancelled: boolean;
}
export interface LspNavGuard { readonly cancelled: boolean; readonly requestId: string; dispose(): void }
/** Records origin = editor.getPosition(). Cancels the previous guard (lsp:cancel). Cancels itself on a
 *  cursor event whose position ≠ origin, model change, content change, or editor dispose. Disposes the
 *  previous nav's tracked target models whose path is not an open LSP doc. */
export function beginLspNav(editor: monaco.editor.ICodeEditor): LspNavGuard;
export function probeLspNav(model: monaco.editor.ITextModel, position: monaco.Position, kind: NavCommandKind, guard: LspNavGuard): Promise<LspNavProbe>;
export function lspLoadingMessage(language: LspLanguageInfo): NavMessage;   // inline/info "{displayName}: loading workspace…"
export function lspToMonacoRange(r: LspRange): monaco.IRange;
/** Registers one hover provider per id; provider: skip non-open-doc models; flushPending(path) first;
 *  token cancel → lsp:cancel; reply version ≠ currentVersion → null. */
export function registerLspHoverProvider(languageIds: readonly string[]): monaco.IDisposable;  // Slice 6
```

### `webview/nav-outcome.ts` additions
```ts
export type NavOutcome = /* existing, incl. go-basics' unsupported{languageId} */
  | { kind: 'none'; adHocMarker?: string }
  | { kind: 'lsp-missing'; language: LspLanguageInfo } | { kind: 'lsp-crashed'; language: LspLanguageInfo }
  | { kind: 'lsp-loading-timeout'; language: LspLanguageInfo } | { kind: 'lsp-no-root'; language: LspLanguageInfo }
  | { kind: 'cancelled' };
export interface NavClassifyInput { /* existing */
  lsp: { language: LspLanguageInfo; unavailable: 'missing' | 'crashed' | 'no-root' | 'loading-timeout' | null; adHocRoot: boolean; cancelled: boolean } | null }
export interface NavMessageContext { kind: NavCommandKind; word: string | null; index: { loaded; total; done; skipped; capped } | null }
```
Classification order:
1. `!supported` → unsupported.
2. `lsp?.cancelled` → cancelled.
3. `lsp?.unavailable` → `lsp-<reason>` carrying `language`.
4. `timedOut` → timed-out.
5. The existing rules.

An empty LSP result with `adHocRoot` → `{kind:'none', adHocMarker: language.moduleMarker}`.

Messages are the spec §3.3 templates filled from `language`. `cancelled` has no message.
`index === null` skips the still-indexing branch and `indexGapNote`.

### `webview/ts-nav.ts` changes
```ts
export function hasCodeNavigation(languageId: string): boolean;   // TS_LANGS.has(id) || hasLanguageServer(id)
export interface NavDeps { onUnresolved?: UnresolvedResolver; gesture?: 'pointer' }
```
In `runNavCommand`, when `lspLanguage(model.getLanguageId())` is non-null (never an id compare):
1. `beginLspNav(editor)`, which records the origin.
2. If `lspStateForKey(serverKeyForDoc(path))` ∈ {`starting`, `loading`, `restarting`}, call
   `showNavMessage(editor, lspLoadingMessage(language))`.
3. The probe is `probeLspNav`.
4. The reference alternative is unchanged.
5. `NO_MISS`, and the hop loop runs once.
6. Classify with `lsp`; the message context has `index: null`.
7. `navigated` → `openLocation`; `peeked` → `dispatchLocations`.
8. With `gesture === 'pointer'`, `lsp-missing|lsp-crashed|lsp-no-root` messages are suppressed.
9. The guard is disposed in `finally`.

The TS/JS behaviour is byte-for-byte unchanged.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Server-language tab text/version | `app.tsx` reconcile + model content events (`lsp-sync`) | `LspManager` doc table → gopls | Both |
| Client identity (epoch) | preload `LSP_EPOCH` | `LspManager` client table / retire | Both |
| Which languages have a server | host registry → `statusSnapshot.languages` | `lsp-status` → `hasLanguageServer` → ts-nav, code-viewer, breadcrumb, app reconcile, hover registration, palette | Both |
| Unopened-file disk changes | `lsp-watcher` (filter from `spec.watchGlobs`) | gopls `didChangeWatchedFiles`; manager re-home | Both |
| Open-but-inactive tab rewritten on disk | host `fileContent` → `files` map (`app.tsx:334`) | reconcile → `lsp:change` | Consumer only; producer unchanged, and its dirty guard already keeps a dirty tab's map entry |
| Nav outcomes/messages | `runNavCommand` LSP branch | `navOutcomeMessage`, `showNavMessage` (+ dedupe) | Both |
| `unsupported` copy | go-basics | non-server languages only (`supported` is true for server languages) | Consumer side |
| Nav landing in another file | `openLocation` (unchanged) | app opener → tab + reveal; nav-history later | Producer reused, not modified |
| Peek target models | `probeLspNav` | Monaco peek; `code-viewer.tsx:156-167` reuse at tab open | Both; disposal skips open docs |
| Breadcrumb symbols | host `documentSymbol` → `toNavTree` | `breadcrumb-bar.tsx` → `enclosingSymbolChain` (unchanged) | Both |
| Server status | `LspManager` → `lsp:status` + snapshot | `lsp-status` → loading message, palette entries | Both |
| Process lifetime | `LspManager` (`stopping`, `disposed`), `lsp-server.stop` | `before-quit` → `killAllSync`; webContents `destroyed` → `dropWebContents`; reload → epoch retire | Both |
| Reply paths under a junction/subst | gopls (realpath spelling) | manager `toLexicalPath` → renderer tabs/LRU | Both |
| `canonicalPath` | `src/canonical-path.ts` (moved) | `project-index.ts`, `app.tsx:120`, `code-viewer.tsx`, `markdown-viewer.tsx:26`, `test/unit/path-identity.test.ts:16`, host code | All importers updated in T1.1 |
| Nav menu enabled / Ctrl+click | `hasCodeNavigation` | `code-viewer.tsx` menu + `onMouseDown` gate | Both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/canonical-path.ts` | create | `canonicalPath`, moved verbatim |
| `webview/project-index.ts` | modify | import `canonicalPath`; drop its definition and `WIN_DRIVE` |
| `src/lsp-uri.ts` | create | path ⇄ `file:` URI |
| `src/lsp-protocol.ts` | create | invoke-channel types, `LspLanguageInfo`, `parseLspMessage`, `parseLspEnvelope` |
| `src/lsp-binary.ts` | create | PATH/extra-dir search, `resolveServerBinary` |
| `src/lsp-registry.ts` | create | `LanguageServerSpec`, `GO_SERVER`, `languageInfo`, `compileWatchGlobs`, `isRootMarker`, `childEnv` |
| `src/lsp-root.ts` | create | root/key resolution, `isWithin`, `toLexicalPath` |
| `src/lsp-restart-budget.ts` | create | `nextRestart` |
| `src/lsp-convert.ts` | create | LSP shapes → reply pieces, `NavTreeNode` |
| `src/protocol.ts` | modify | `HostToWebview` `lsp:status` |
| `electron/process-tree.ts` | create | PID-scoped tree kill |
| `electron/lsp-server.ts` | create | one server process + JSON-RPC connection |
| `electron/lsp-watcher.ts` | create | per-root recursive watch |
| `electron/lsp-manager.ts` | create | clients, docs, servers, lifecycle, routing |
| `electron/main.ts` | modify | manager with real deps; `ipcMain.handle('lsp')`; `destroyed` → drop; `before-quit` |
| `electron/preload.ts` | modify | `LSP_EPOCH`; `lsp(msg)` wraps `{epoch,msg}` |
| `webview/bridge.ts` | modify | `HostBridge.lsp`, `lspInvoke` + fake |
| `webview/lsp-status.ts` | create | servers + languages store, hooks, `restartableLanguages` |
| `webview/lsp-sync.ts` | create | doc sync, debounce/flush, versions, `lspRequest` |
| `webview/lsp-nav.ts` | create | LSP probe, nav guard, target models, loading message, hover provider |
| `webview/nav-outcome.ts` | modify | LSP outcomes/messages, nullable index |
| `webview/ts-nav.ts` | modify | LSP branch; `hasCodeNavigation`; `NavDeps.gesture` |
| `webview/monaco-message.ts` | modify | toast dedupe by text while visible |
| `webview/components/code-viewer.tsx` | modify | `hasCodeNavigation` gates; `gesture:'pointer'`; `canonicalPath` import |
| `webview/components/breadcrumb-bar.tsx` | modify | server-language symbols via `lspRequest('documentSymbol')` |
| `webview/components/markdown-viewer.tsx` | modify | `canonicalPath` import only |
| `webview/app.tsx` | modify | `canonicalPath` import; `initLspClient`; reconcile effect; palette entries (Slice 5); hover registration (Slice 6) |
| `package.json`, `package-lock.json` | modify | two dependencies |
| `docs/adr/0006-host-side-language-servers.md` | create | ADR 0006, proposed |
| `test/unit/lsp-uri.test.ts`, `lsp-protocol.test.ts`, `lsp-binary.test.ts`, `lsp-registry.test.ts`, `lsp-root.test.ts`, `lsp-restart-budget.test.ts`, `lsp-convert.test.ts`, `process-tree.test.ts`, `lsp-server.test.ts`, `lsp-watcher.test.ts`, `lsp-manager.test.ts`, `lsp-status.test.ts`, `lsp-sync.test.ts`, `lsp-nav.test.ts` | create | unit coverage |
| `test/unit/path-identity.test.ts`, `test/unit/nav-outcome.test.ts` | modify | import path; new outcome cases |
| `test/e2e/go-lsp.e2e.mjs` | create | real-gopls scenarios on a temp module |

## Scripts

None (`SCRIPT_CANDIDATES: 0`, deliberately). The temp Go module has one caller, so it is
`writeGoFixture(dir)` inside the e2e file.

## Slices

### Slice 1: Pure seams and the protocol dependency

**Check:** these pass:
- `npx vitest run test/unit/lsp-uri.test.ts test/unit/lsp-protocol.test.ts test/unit/lsp-binary.test.ts test/unit/lsp-registry.test.ts test/unit/lsp-root.test.ts test/unit/lsp-restart-budget.test.ts test/unit/lsp-convert.test.ts test/unit/path-identity.test.ts`
- `npm run typecheck`
- `npm run fallow:check`

**Parallel groups:** G1: T1.2, T1.3 · G2: T1.5 then T1.4 (T1.4 consumes `HostPlatform`, `LanguageServerSpec`) · Serial: T1.1 (touches `app.tsx`), T1.6 (package files), then T1.7 (needs T1.2, T1.3, T1.6)
**Claims (serial lane):** `webview/app.tsx` (T1.1), `package.json`, `package-lock.json` (T1.6)

#### Task 1.1: Move `canonicalPath` to `src/`
**Files:** Create `src/canonical-path.ts`. Modify:
- `webview/project-index.ts` (lines 3-21 out, import in);
- `webview/app.tsx:120`;
- `webview/components/code-viewer.tsx` (the `../project-index` import block);
- `webview/components/markdown-viewer.tsx:26`;
- `test/unit/path-identity.test.ts:16`.

**Interfaces:** Produces `canonicalPath(path: string): string`.
**Call sites:** the five importers above. Re-grep `canonicalPath` across `webview src electron test`.
There must be **no** re-export from `project-index.ts`.
**Steps:**
- [ ] Port task. Proof: `test/unit/path-identity.test.ts` (import switched) stays green, and `npm run typecheck` is green.

#### Task 1.2: `lsp-uri`
**Files:** Create `src/lsp-uri.ts`. Test `test/unit/lsp-uri.test.ts`.
**Interfaces:** Produces `pathToFileUri`, `fileUriToPath`. Consumes `canonicalPath(path: string): string` (T1.1).
**Steps:**
- [ ] Failing tests:
  - 'upper-cases the drive and flips separators': `pathToFileUri('g:\\a b\\c#.go') === 'file:///G:/a%20b/c%23.go'`.
  - 'POSIX path': `pathToFileUri('/home/x/ü.go') === 'file:///home/x/%C3%BC.go'`.
  - 'reverse accepts every drive spelling' (`file:///c%3A/x/y.go`, `file:///c:/…`, `file:///C:/…` → `C:\\x\\y.go`).
  - 'UNC round-trips'.
  - 'non-file is null'.
  - 'round trip is identity for canonical paths'.
- [ ] Run: FAIL (module missing). Implement.

#### Task 1.3: `lsp-protocol`
**Files:** Create `src/lsp-protocol.ts`. Test `test/unit/lsp-protocol.test.ts`.
**Interfaces:** Produces every type in the `src/lsp-protocol.ts` contract, plus `parseLspMessage` and `parseLspEnvelope`. Consumes the `NavTreeNode` type from `src/breadcrumbs.ts:111`.
**Steps:**
- [ ] Failing tests:
  - 'accepts each well-formed message type' (7).
  - 'rejects a relative path'.
  - 'rejects negative or fractional line/character'.
  - 'rejects an unknown op or type'.
  - 'rejects requestId over 64'.
  - 'accepts drive, POSIX and UNC absolute paths'.
  - 'envelope needs a non-empty epoch ≤ 64 and a valid msg': `parseLspEnvelope({epoch:'', msg:valid}) === null`, and `parseLspEnvelope({epoch:'e', msg:{type:'x'}}) === null`.
- [ ] Run: FAIL. Implement.

#### Task 1.4: `lsp-root` + `lsp-restart-budget`
**Files:** Create `src/lsp-root.ts`, `src/lsp-restart-budget.ts`. Test `test/unit/lsp-root.test.ts`, `test/unit/lsp-restart-budget.test.ts`.
**Interfaces:** Produces `RootProbe`, `ServerRoot`, `resolveServerRoot`, `serverKeyFor`, `isWithin`, `toLexicalPath`, `RESTART_DELAYS_MS`, `RESTART_WINDOW_MS`, `nextRestart`. Consumes:
- `canonicalPath(path: string): string` (T1.1);
- `HostPlatform = 'win32' | 'darwin' | 'linux'` from `src/lsp-binary.ts` (T1.5);
- `LanguageServerSpec` (for `Pick<…,'languageId'|'rootMarkers'>`) from `src/lsp-registry.ts` (T1.5).

**Steps:**
- [ ] Failing tests (root, fake probe):
  - 'nearest go.mod wins'.
  - 'highest go.work wins over a nearer go.mod'.
  - 'no marker → workspace root, adHoc'.
  - 'deepest workspace root is used'.
  - 'outside every root → null'.
  - 'win32 containment is case-insensitive' (`isWithin('g:\\P\\x','G:\\p','win32')`), and linux is case-sensitive.
  - **#4** 'key uses realRoot; root keeps the lexical spelling': probe.realpath maps `S:\\m` → `G:\\real\\m`, so `key === 'go:G:\\real\\m'`, `root === 'S:\\m'` and `realRoot === 'G:\\real\\m'`.
  - **#4** 'toLexicalPath maps realRoot-prefixed paths onto the lexical root and leaves others alone': `toLexicalPath('G:\\real\\m\\a.go','G:\\real\\m','S:\\m','win32') === 'S:\\m\\a.go'`, and `toLexicalPath('C:\\goroot\\x.go', …)` is unchanged.
- [ ] Failing tests (budget):
  - 'delays 1s, 4s, 16s then null'.
  - 'entries older than 5 min fall out'.
- [ ] Run: FAIL. Implement.

#### Task 1.5: `lsp-binary` + `lsp-registry`
**Files:** Create `src/lsp-binary.ts`, `src/lsp-registry.ts`. Test `test/unit/lsp-binary.test.ts`, `test/unit/lsp-registry.test.ts`.
**Interfaces:** Produces these, per the contract:
- from `src/lsp-binary.ts`: `HostPlatform`, `SearchContext`, `pathDirs`, `findBinary`, `ResolvedServer`, `resolveServerBinary`;
- from `src/lsp-registry.ts`: `LanguageServerSpec`, `GO_FIXED_DIRS`, `GO_SERVER`, `LANGUAGE_SERVERS`, `serverSpecFor`, `languageInfo`, `compileWatchGlobs`, `isRootMarker`.

It consumes `LspLanguageInfo` (T1.3).
**Steps:**
- [ ] Failing tests:
  - 'relative and empty PATH entries are skipped'.
  - 'win32 reads Path case-insensitively'.
  - 'win32 candidate is name.exe only'.
  - 'first regular file wins and is realpath'd'.
  - 'search order is PATH, GOBIN, GOPATH entries, go env GOPATH, ~/go/bin'.
  - 'go env runs in tmpdir with GOTOOLCHAIN=local and 5 s timeout'.
  - 'go env failure is not fatal'.
  - 'finds go in GO_FIXED_DIRS when PATH lacks it'.
  - 'childEnv prepends toolDir and sets GOTOOLCHAIN=local'.
  - 'childEnv keeps a user GOTOOLCHAIN'.
  - **#14** 'childEnv drops non-absolute PATH entries': base `Path='.;bin;C:\\x'` (win32) → `Path === 'C:\\Go\\bin;C:\\x'`.
  - 'childEnv never mutates base'.
  - 'serverSpecFor("gomod") is null'.
  - **#10** 'compileWatchGlobs(GO_SERVER.watchGlobs) matches a/b.go, go.mod, x/go.sum, go.work and rejects a.ts, go.mod.bak'.
  - **#10** 'compileWatchGlobs throws on an unsupported glob shape (src/**/x.go)'.
  - **#10** 'every LANGUAGE_SERVERS entry compiles its globs'.
  - 'isRootMarker true for x/go.mod and go.work'.
  - 'languageInfo(GO_SERVER) has moduleMarker go.mod'.
- [ ] Run: FAIL. Implement.

#### Task 1.6: Add the protocol dependency
**Files:** Modify `package.json` (`"vscode-languageserver-protocol": "^3.18.3"`) and `package-lock.json` (`npm install vscode-languageserver-protocol@^3.18.3`). `vscode-jsonrpc` is added by T2.2, its first importer.
**Steps:**
- [ ] Port-style task. Proof: `npm run fallow:check` is green after T1.7.

#### Task 1.7: `lsp-convert`
**Files:** Create `src/lsp-convert.ts`. Test `test/unit/lsp-convert.test.ts`.
**Interfaces:** Produces `toLocations`, `toHover`, `toNavTree`, `offsetAt`, `symbolKindName`. Consumes:
- `fileUriToPath` (T1.2);
- `LspRange`, `LspPosition` (T1.3);
- `NavTreeNode`;
- types and `SymbolKind` from `vscode-languageserver-protocol`.

**Steps:**
- [ ] Failing tests:
  - 'LocationLink uses targetSelectionRange'.
  - 'upper-case drive URIs map to canonical paths'.
  - 'non-file dropped'.
  - 'duplicates collapse'.
  - 'MarkupContent passes through'.
  - 'MarkedString array joined with fences'.
  - 'hierarchical symbols keep nesting and offsets'.
  - 'flat SymbolInformation becomes one level'.
  - 'unknown kind → empty string'.
  - 'offsetAt clamps'.
  - 'CRLF offsets count the \\r'.
- [ ] Run: FAIL. Implement. `npm run fallow:check` green.

### Slice 2: One server process

**Check:** `npx vitest run test/unit/process-tree.test.ts test/unit/lsp-server.test.ts` passes, and `npm run typecheck` and `npm run fallow:check` are green.

**Parallel groups:** G1: T2.1 · Serial: T2.2 (consumes T2.1)
**Claims (serial lane):** `package.json`, `package-lock.json` (T2.2)

#### Task 2.1: `process-tree`
**Files:** Create `electron/process-tree.ts`. Test `test/unit/process-tree.test.ts`.
**Interfaces:** Produces `TreeKillDeps`, `killTree`, `killTreeSync`, `defaultTreeKillDeps`.
**Steps:**
- [ ] Failing tests:
  - 'win32 runs taskkill by absolute path with /T /F'.
  - 'posix kills the negative pid'.
  - 'sync variant uses execFileSync'.
  - 'an exec failure resolves false, never throws'.
- [ ] Run: FAIL. Implement.

#### Task 2.2: `lsp-server`
**Files:**
- Create `electron/lsp-server.ts`.
- Modify `package.json` (`"vscode-jsonrpc": "^9.0.2"`) and `package-lock.json` (`npm install vscode-jsonrpc@^9.0.2`; `npm ls vscode-jsonrpc` must show a single deduped 9.0.2).
- Test `test/unit/lsp-server.test.ts`. The fake child is an EventEmitter with PassThrough stdio, and a peer `createMessageConnection` acts as a scripted server.

**Interfaces:** Produces `ChildLike`, `SpawnFn`, `StartServerOptions`, `LspLog`, `LspRequestError`, `LspServerHandle`, `startLanguageServer`. Consumes:
- `LanguageServerSpec` (`childEnv`, `args`) and `HostPlatform` (T1.5);
- `pathToFileUri` (T1.2);
- `killTree`, `killTreeSync`, `TreeKillDeps` (T2.1);
- `createMessageConnection`, `StreamMessageReader`, `StreamMessageWriter` from `vscode-jsonrpc/node`.

**Steps:**
- [ ] Failing tests:
  - **E9** 'spawns the resolved absolute binary with no shell, cwd = root, detached only on posix, env from childEnv (GOTOOLCHAIN=local, no relative PATH entries)'.
  - 'initialized resolves after initialize and sends initialized; rootUri = pathToFileUri(root)'.
  - 'initialize error rejects initialized'.
  - 'progress begin/end toggles loading'.
  - **#8** 'a request is sent immediately while a progress token is open' (no gating in the handle).
  - 'workspace/configuration answers one null per item'.
  - 'unknown server request gets MethodNotFound'.
  - 'publishDiagnostics dropped, showMessage logged'.
  - 'timeout rejects LspRequestError("timeout") and sends $/cancelRequest'.
  - **#8** 'abort signal sends $/cancelRequest and rejects cancelled'.
  - 'exit fires onExit with the last 50 stderr lines'.
  - **#12** 'stop sends shutdown, then killTree on reply — no exit notification is ever sent' (the peer asserts it never received `exit`).
  - **#12** 'stop kills after 2 s when shutdown is never answered'.
  - 'killSync calls killTreeSync with the pid'.
- [ ] Run: FAIL. Implement.

### Slice 3: Manager and watcher

**Check:** `npx vitest run test/unit/lsp-watcher.test.ts test/unit/lsp-manager.test.ts` passes, and `npm run typecheck` is green.

**Parallel groups:** G1: T3.1 · Serial: T3.2 (consumes T3.1)
**Claims (serial lane):** none

#### Task 3.1: `lsp-watcher`
**Files:** Create `electron/lsp-watcher.ts`. Test `test/unit/lsp-watcher.test.ts` (injected `watch`/`stat`, fake timers).
**Interfaces:** Produces `WatchedChange`, `LspWatcherHandle`, `watchServerRoot`. Consumes:
- `shouldIgnoreWatchPath(rel: string): boolean` (`src/watch-filter.ts:30`);
- tests only: `compileWatchGlobs`, `isRootMarker`, `GO_SERVER` (T1.5).

**Steps:**
- [ ] Failing tests:
  - **#10** 'only rels passing filter.matches reach onChanges' (filter built from `GO_SERVER`; `x.ts` dropped).
  - **#10** 'a custom matcher (`**/*.rs`) is honoured — the watcher knows no language'.
  - 'node_modules and .git noise ignored'.
  - 'a 200 ms burst becomes one batch with the last type per path'.
  - 'deleted 3, created 1, modified 2'.
  - 'a marker rel fires onMarker once per batch'.
  - 'close stops watcher and timer'.
  - 'watch error closes and logs'.
- [ ] Run: FAIL. Implement (recursive `fs.watch`, as `electron/project-watcher.ts:38` does).

#### Task 3.2: `lsp-manager`
**Files:** Create `electron/lsp-manager.ts`. Test `test/unit/lsp-manager.test.ts`. The fake `LspServerHandle` records notifies and requests, and exposes `resolveInitialized()`, `rejectInitialized()`, `emitExit()`, `setLoading()` and scripted request answers. Tests use `vi.useFakeTimers()`. The `env(epoch, msg)` helper builds envelopes.
**Interfaces:** Produces `LspManagerDeps`, the constants, and `LspManager`. Consumes:
- `parseLspEnvelope` and all `src/lsp-protocol.ts` types (T1.3);
- `ServerRoot`, `isWithin`, `toLexicalPath`, `nextRestart` (T1.4);
- `LanguageServerSpec`, `ResolvedServer`, `languageInfo`, `HostPlatform` (T1.5);
- `toLocations`, `toHover`, `toNavTree` (T1.7);
- `LspServerHandle`, `LspRequestError`, `LspLog` (T2.2);
- `WatchedChange`, `LspWatcherHandle` (T3.1).

**Steps:**
- [ ] Failing tests:
  - **Sharing and validation:**
    - **E1** 'two docs under one module from two windows share one server'.
    - **E1** 'two modules without go.work get two servers'.
    - 'invalid envelope → typed failure, nothing started'.
    - 'open/change/request for one path reach the server in arrival order although root resolution is async'.
  - **Clients and epochs (#2):**
    - **#2 / E13** 'a new epoch on the same webContents retires the old epoch: its refs drop (didClose at 0), and the new epoch's open re-syncs and is answered'.
    - **#2** 'a straggler from a retired epoch is rejected and changes nothing'.
    - **#2** 'dropWebContents drops every epoch of it'.
  - **Stale (#3):**
    - **#3 / E14** 'identical text in two windows: both windows' requests are answered, whichever wrote last'.
    - **#3** 'only the diverged window gets stale'.
    - 'an old version from the same client → stale'.
  - **Lexical root (#4):**
    - **#4** 'realpath differs from the doc path: gopls gets the lexical root (initialize rootUri and didOpen URIs agree), and a returned realpath location is mapped back to the lexical path'.
  - **Replay and liveness (#5):**
    - **#5** 'restart: didOpen replay for every table doc precedes state ready and precedes any queued request'.
    - **#5** 'change while restarting updates only the table; the replay sends the latest text and version'.
  - **Request timing and cancel (#8):**
    - **#8** 'nav while loading is sent immediately (not held for progress end) and answered'.
    - **#8** 'nav while starting times out at 90 s total → loading-timeout'.
    - 'ready nav times out at 10 s → timeout'.
    - 'hover while starting waits ≤ 3 s then empty'.
    - **#8** 'lsp:cancel during the initialize wait aborts it (no request is ever sent); lsp:cancel after send sends $/cancelRequest'.
  - **Absent and crash:**
    - **E5** 'missing binary → absent status, request → missing; open ok'.
    - 'absent cached 30 s; re-probe starts and replays'.
    - **E6** 'unexpected exit restarts after 1 s with replay; 4th exit in 5 min → crashed'.
  - **Ordered stops and quit (#1):**
    - **#1** 'an exit after idle stop / restart command / re-home (stopping) never restarts'.
    - **#1 / E7** 'an exit after killAllSync does not restart, and pending restart timers are cleared'.
    - **#1 / E7** 'an open whose resolveRoot resolves after killAllSync never calls startServer'.
    - **#1** 'a restart delay that elapses after killAllSync never calls startServer'.
    - 'killAllSync calls killSync on every live server'.
  - **Restart command:**
    - 'restart {languageId} marks stopping, stops all, clears budget and absent cache, broadcasts stopped'.
  - **Lifetime (#13):**
    - **#13 / E8** 'last tab closes → stop after 60 s; an open before 60 s cancels'.
    - **#13** 'there is no session input: LspManagerDeps has no sessionRoots' (a type-level assertion via `expectTypeOf`).
  - **Replies, re-home and status:**
    - 'locations: an out-of-root path goes to the LRU; a later open of it attaches to that server'.
    - 'targets exclude paths open by the requesting client; over 200 or unreadable are dropped and counted'.
    - 'empty result under an ad-hoc root → {kind:"empty", adHocRoot:true}'.
    - 'a marker event re-homes a doc'.
    - 'watcher changes forward as didChangeWatchedFiles'.
    - 'documentSymbol → NavTreeNode from the synced text'.
    - 'statusSnapshot lists servers with pid and languages from the registry'.
    - 'every transition broadcasts a status with pid'.
- [ ] Run: FAIL. Implement.

### Slice 4: Host wiring

**Check:** `npm run typecheck && npm run build` pass. Then `node test/e2e/run-smoke.mjs go-lsp` passes the three host-level scenarios below. The fixture needs gopls on the machine; the precondition is in the scenario.

**Parallel groups:** Serial: T4.1 → T4.2
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `electron/preload.ts` (T4.1); `test/e2e/go-lsp.e2e.mjs` (T4.2)

#### Task 4.1: Wire manager, IPC, preload
**Files:** Modify `src/protocol.ts` (`HostToWebview`), `electron/main.ts`, `electron/preload.ts`.
**Interfaces:**
- Produces:
  - preload `const LSP_EPOCH = globalThis.crypto.randomUUID()`;
  - `api.lsp(msg: LspMessage): Promise<LspResult<LspCallType>>`, which is `ipcRenderer.invoke('lsp', { epoch: LSP_EPOCH, msg })`;
  - the `HostToWebview` variant `{ type: 'lsp:status'; status: LspServerStatus }`.
- Consumes:
  - `LspManager`, `LspManagerDeps` (T3.2);
  - `resolveServerBinary`, `SearchContext`, `LANGUAGE_SERVERS`, `compileWatchGlobs`, `isRootMarker` (T1.5);
  - `resolveServerRoot` (T1.4);
  - `startLanguageServer` (T2.2);
  - `defaultTreeKillDeps` (T2.1);
  - `watchServerRoot` (T3.1).

main.ts specifics:
- Construct the manager inside `app.whenReady` **after** `writeRoots` (`electron/main.ts:3412`). Its deps:
  - `workspaceRoots: writeRoots`;
  - `broadcastStatus: s => broadcast({type:'lsp:status', status:s})`;
  - `readTarget`: `fs.promises.stat` (regular file, ≤ 2 MB) + `readFile(utf8)`;
  - `resolveBinary: spec => resolveServerBinary(spec, ctx)`, where `ctx` is `process.env`, `process.platform`, `os.homedir()`, `os.tmpdir()`, `stat().isFile()`, `fs.promises.realpath`, and `execFile` (promisified, `windowsHide:true`);
  - `resolveRoot: (p, spec) => resolveServerRoot(p, writeRoots(), spec, {exists, realpath}, process.platform)`;
  - `startServer: o => startLanguageServer({ …o, spawn: child_process.spawn, tree: defaultTreeKillDeps(), hostEnv: process.env, platform: process.platform, log })`;
  - `watchRoot: (root, spec, a, b) => watchServerRoot(root, { matches: compileWatchGlobs(spec.watchGlobs), isMarker: rel => isRootMarker(spec, rel) }, a, b)`;
  - `log`.
- Register `ipcMain.handle('lsp', (e, raw) => { trackSender(e.sender); return manager.handle(e.sender.id, raw); })`. `trackSender` attaches `'destroyed'` → `dropWebContents(id)` once per webContents. **A reload is handled by the epoch** (the new page load sends a new epoch), not by a navigation event.
- In `before-quit`, call `lspManager.killAllSync()` next to `pty.disposeAll()` (`electron/main.ts:3607-3647`).

**Steps:**
- [ ] `npm run typecheck && npm run build` green (wiring; behaviour is proven by T4.2 and Slice 3).

#### Task 4.2: e2e scaffold, host-level scenarios
**Files:** Create `test/e2e/go-lsp.e2e.mjs`.
**Interfaces:** Consumes the harness (`launchApp`, `openSession`, `closeApp`, `runScenario`, `assert`) and `window.agentDeck.lsp` (T4.1).

**Fixture:** `writeGoFixture(dir)` writes these files into `mkdtempSync(join(tmpdir(), 'conduit-go-'))`:

| File | Content |
|---|---|
| `go.mod` | `module example.com/fix\n\ngo 1.22\n` |
| `main.go` | package main; imports `example.com/fix/pkg/util`; `func main() { helper(); _ = util.Greet() }` |
| `helper.go` | `func helper() {}` |
| `pkg/util/util.go` | `// Greet says hi.\nfunc Greet() string { return "hi" }` |

**Precondition:** resolve `gopls` as the host does (`where gopls`, or `%USERPROFILE%\go\bin\gopls.exe`). If it is absent, fail with `go-lsp e2e needs gopls: go install golang.org/x/tools/gopls@latest`.

The shared helper `recordTree(pid)` walks `Get-CimInstance Win32_Process` on `ParentProcessId` and returns the PID plus every descendant.

**Steps:**
- [ ] Scenario 'host: definition across files via the bridge':
  - `openSession`, then `lsp:open` main.go.
  - Poll `lsp:statusSnapshot` for `ready` (ceiling 120 s).
  - `lsp:request definition` at `helper` → `locations[0].path` ends with `helper.go`, and `range.start.line === 2`.
- [ ] Scenario **E7** 'no orphans after a normal quit':
  - Call `recordTree(pid from snapshot)`, then `closeApp`.
  - Poll up to 5 s until `process.kill(p, 0)` throws for every recorded PID.
- [ ] Scenario **#6 / E7** 'no orphans after the main process is force-killed' (separate launch):
  - Wait for `ready`, then call `recordTree(gopls pid)`.
  - Run `taskkill /PID <app.process().pid> /F` with **no `/T`**.
  - Poll up to 5 s: every recorded PID is gone.
  - **If this scenario fails, the build stops here** and reports to the conductor: the Job object becomes in-scope and is re-planned (Decisions Needed). It is not a flake to retry past.
- [ ] Run `node test/e2e/run-smoke.mjs go-lsp` alone: green.

### Slice 5: LSP navigation in the editor + palette restart

**Check:**
- `npx vitest run test/unit/lsp-status.test.ts test/unit/lsp-sync.test.ts test/unit/lsp-nav.test.ts test/unit/nav-outcome.test.ts test/unit/nav-failure.test.ts` is green.
- `npm run typecheck` is green.
- `node test/e2e/run-smoke.mjs go-lsp` passes these, plus Slice 4's scenarios: F12 in-package, Ctrl+click cross-package, references peek, agent-edits-unopened-file, gopls missing, palette restart.
- `node test/e2e/run-smoke.mjs goto-index` is still green.

**Parallel groups:** G1: T5.1 · G2: T5.3 · Serial: T5.0 (bridge), then T5.2 (consumes 5.0 and 5.1), T5.4 (consumes 5.2 and 5.3), T5.5 (`code-viewer.tsx` + `app.tsx`), T5.6 (e2e)
**Claims (serial lane):** `webview/bridge.ts` (T5.0), `webview/app.tsx` (T5.5), `test/e2e/go-lsp.e2e.mjs` (T5.6)

#### Task 5.0: Bridge
**Files:** Modify `webview/bridge.ts` (`HostBridge` gains `lsp(msg: LspMessage): Promise<LspResult<LspCallType>>`).
**Interfaces:** Produces `lspInvoke<K extends LspCallType>(msg: LspMessage<K>): Promise<LspResult<K>>`, with the contract's fake. The single cast from `LspResult<LspCallType>` to `LspResult<K>` sits at this boundary, like `ts-nav.ts:182`.
**Steps:**
- [ ] `npm run typecheck` green; behaviour is proven via T5.2's mocks.

#### Task 5.1: Status and language store
**Files:** Create `webview/lsp-status.ts`. Test `test/unit/lsp-status.test.ts`.
**Interfaces:** Produces `applyLspStatus`, `seedLspState`, `lspStateForKey`, `lspLanguage`, `hasLanguageServer`, `subscribeLspStatus`, `useLspStatuses`, `useLspLanguages`, `restartableLanguages`. Consumes `LspServerStatus`, `LspDocState`, `LspLanguageInfo` (T1.3).
**Steps:**
- [ ] Failing tests:
  - 'stopped removes the entry'.
  - 'later status replaces earlier'.
  - **#10** 'hasLanguageServer reflects the seeded languages only (go true after seed, false before; rust false)'.
  - **#7** 'restartableLanguages lists a language with an absent or crashed entry, not one with none'.
  - 'lspStateForKey(null) is null'.
- [ ] Run: FAIL. Implement.

#### Task 5.2: `lsp-sync`
**Files:** Create `webview/lsp-sync.ts`. Test `test/unit/lsp-sync.test.ts`. It mocks `../../webview/bridge` (`lspInvoke`, `subscribe`) and uses a minimal `monaco-editor` mock as in `test/unit/nav-failure.test.ts:34-52`, with `onDidCreateModel` and `getModel`.
**Interfaces:** Produces `LspDocInput`, `LSP_CHANGE_DEBOUNCE_MS`, `initLspClient`, `reconcileLspDocs`, `isLspDocOpen`, `serverKeyForDoc`, `flushPending`, `currentVersion`, `subscribeLspDocSent`, `lspRequest`. Consumes:
- `lspInvoke` (T5.0);
- `seedLspState`, `applyLspStatus` (T5.1);
- `fileUri` (`webview/project-index.ts`);
- `subscribe` (`webview/bridge.ts`).

**Steps:**
- [ ] Failing tests:
  - 'reconcile opens new docs with version 1 and closes removed ones'.
  - 'unchanged text sends nothing'.
  - 'model edits debounce to one lsp:change at 150 ms'.
  - 'flushPending sends immediately and resolves after the invoke'.
  - 'a request carries the last sent version'.
  - 'a request for a path not open resolves empty without invoking'.
  - 'open reply records serverKey'.
  - 'only models whose uri equals fileUri(tab path) are attached'.
  - 'subscribeLspDocSent fires after each sent change'.
  - 'initLspClient seeds servers and languages from statusSnapshot and applies lsp:status pushes'.
- [ ] Run: FAIL. Implement.

#### Task 5.3: Outcomes, templated messages, toast dedupe
**Files:** Modify `webview/nav-outcome.ts`, `webview/monaco-message.ts`, `webview/ts-nav.ts` (only the three call sites below), and `test/unit/nav-outcome.test.ts`.
**Interfaces:** Produces the `NavOutcome` additions, `NavClassifyInput.lsp`, and `NavMessageContext.index: … | null`. `showNavMessage` skips `pushToast` when `getToastsSnapshot().some(t => t.message === message.text)`. Consumes `LspLanguageInfo` (T1.3).
**Call sites:**
- `classifyNavOutcome` at `webview/ts-nav.ts:538` passes `lsp: null` for now; T5.4 fills it.
- `navOutcomeMessage` at `:584` and `:598` is unchanged in shape.
- Existing tests pass `lsp: null`.

T5.4 runs after this task, so there is no concurrent edit of `ts-nav.ts`.
**Steps:**
- [ ] Failing tests:
  - **#10** 'each lsp reason renders its template from the language info'. With a fake language `{displayName:'Rust', binary:'rust-analyzer', installHint:'rustup component add rust-analyzer', moduleMarker:'Cargo.toml'}`, assert `'Rust navigation needs rust-analyzer — install with `rustup component add rust-analyzer`'`.
  - 'the Go info renders the spec's exact Go strings' (all five, plus "(no go.mod found for this file)").
  - 'cancelled has no message'.
  - 'index null skips the still-indexing branch and gap note'.
  - 'lsp reasons outrank timedOut'.
  - 'showNavMessage toast is deduped while visible and pushes again after dismiss'.
- [ ] Run: FAIL. Implement.

#### Task 5.4: `lsp-nav` + the LSP branch in `runNavCommand`
**Files:** Create `webview/lsp-nav.ts`. Modify `webview/ts-nav.ts`. Test `test/unit/lsp-nav.test.ts`.

The test mirrors `nav-failure.test.ts`'s monaco mock. It adds `onDidChangeCursorPosition` (emitting `{position}`), `onDidChangeModel`, `onDidChangeModelContent` and `onDidDispose` on the fake editor. It mocks:
- `../../webview/lsp-sync`: `lspRequest`, `flushPending`, `serverKeyForDoc`, `isLspDocOpen`;
- `../../webview/lsp-status`: `lspStateForKey`, `lspLanguage`, `hasLanguageServer`.

It spies `setDefinitionOpener`.
**Interfaces:**
- Produces `LspNavProbe`, `LspNavGuard`, `beginLspNav`, `probeLspNav`, `lspLoadingMessage`, `lspToMonacoRange`, `hasCodeNavigation(languageId: string): boolean`, and `NavDeps.gesture?: 'pointer'`.
- Consumes:
  - `lspRequest(path: string, op: LspOp, pos: LspPosition, requestId: string): Promise<LspReply>`, `flushPending(path: string): Promise<void>`, `serverKeyForDoc(path: string): string | null`, `isLspDocOpen(path: string): boolean` (T5.2);
  - `lspStateForKey(serverKey: string | null): LspDocState | null`, `lspLanguage(languageId: string): LspLanguageInfo | null`, `hasLanguageServer(languageId: string): boolean` (T5.1);
  - the outcome/message types (T5.3);
  - `langFromPath`, `ensureTokenizer`, `fileUri`, `pathForUri`.

`registerLspHoverProvider` is **not** produced here; its first caller is Slice 6.
**Call sites:** `runNavCommand` callers are unchanged. `TS_LANGS` stays exported until T5.5.
**Steps:**
- [ ] Failing tests:
  - **Navigation (E2):**
    - **E2** 'F12 on a server-language model flushes, asks definition, and one other-file result opens via the definition opener'.
    - 'many results peek via peekLocations with models from targets'.
    - 'definition at the cursor falls through to references'.
    - 'Alt+F12 asks definition and peeks'.
  - **Cancellation (E12, #9):**
    - **E12** 'a cursor move to a different position before the reply → no open, no message, lsp:cancel sent'.
    - **#9** 'a cursor event AT the nav origin (Ctrl+click's own setPosition) does not cancel': the event is emitted with `position === origin` after `beginLspNav`, and the nav still opens.
    - **E12** 'a second nav cancels the first'.
    - 'stale reply → cancelled, silent'.
  - **Messages:**
    - 'loading state shows "Go: loading workspace…" first'.
    - 'missing → install toast; pointer gesture → silent'.
    - 'timeout → timed-out message'.
  - **Isolation:**
    - **#10** 'the branch is chosen by lspLanguage, not by id': mock `lspLanguage('rust')` → a Rust info, and a `rust` model takes the LSP branch.
    - 'an LSP nav never calls the TS worker'.
    - 'a TS nav is unchanged'.
  - **Cleanup:**
    - 'previous nav's target models are disposed unless an open doc'.
- [ ] Run: FAIL. Implement.

#### Task 5.5: Editor gates, app wiring, palette restart (#7)
**Files:** Modify `webview/components/code-viewer.tsx`, `webview/app.tsx`, and `webview/ts-nav.ts` (the `TS_LANGS` export only, if now unused).

In `code-viewer.tsx`:
- The context-menu `canGoToDefinition` and the `onMouseDown` gate use `hasCodeNavigation`.
- Ctrl+click calls `runNavCommand(editor, 'editor.action.revealDefinition', { gesture: 'pointer' })`.

In `app.tsx`:
- `initLspClient()` runs once and is disposed on unmount, next to `registerTsNavigationProviders` (`~1619-1629`).
- An effect over `[docState.docs, files, languages]` (with `languages = useLspLanguages()`) builds `LspDocInput[]` and calls `reconcileLspDocs`:
  - take file-kind docs whose `langFromPath(path)` satisfies `hasLanguageServer`, deduped;
  - text follows the Settled rule;
  - paths with no text are skipped.
- **Palette (#7, moved here from Slice 6):** in `commandItems` (`~2488`), add one entry per `restartableLanguages(useLspStatuses(), languages)`:
  - `id: \`cmd:restartLsp:${l.languageId}\``;
  - `title: \`Restart ${l.displayName} language server\``;
  - `keywords: [l.binary, l.languageId, 'lsp', 'language server']`;
  - `group: 'Commands'`;
  - `run: () => void lspInvoke({ type: 'lsp:restart', languageId: l.languageId })`.

  Both hook values join the memo deps.

**Interfaces:** Consumes:
- `hasCodeNavigation`, `NavDeps.gesture` (T5.4);
- `initLspClient`, `reconcileLspDocs`, `LspDocInput` (T5.2);
- `useLspLanguages`, `useLspStatuses`, `restartableLanguages`, `hasLanguageServer` (T5.1);
- `lspInvoke` (T5.0).

**Steps:**
- [ ] `npm run typecheck && npm run build` green, and `npx vitest run test/unit/editor-menu.test.ts` green. Behaviour is proven by T5.6.

#### Task 5.6: e2e editor scenarios
**Files:** Modify `test/e2e/go-lsp.e2e.mjs`.
**Steps:**
- [ ] Background: open `main.go` through the Explorer path the other nav e2es use (see `test/e2e/goto-index.e2e.mjs`), and wait for `ready`.
- [ ] Scenario 'definition across files in one package': F12 on `helper` → the active tab is `helper.go`, and the caret line contains `func helper`.
- [ ] Scenario 'definition across packages': Ctrl+click `Greet` with a real mouse → the active tab is `util.go`, and the caret line contains `func Greet`. This also proves #9 end to end.
- [ ] Scenario 'references': Shift+F12 on `helper` in helper.go → the peek lists 2 results.
- [ ] Scenario **E11** 'agent edits an unopened file':
  - Close helper.go and rewrite it on disk to declare `helper2`.
  - Edit main.go to call `helper2()`.
  - Poll up to 5 s: F12 lands in helper.go.
- [ ] Scenario **E5** 'gopls missing' (separate `launchApp({ env })`):
  - Exactly one toast with the install text.
  - No error toast.
  - main.go stays editable.
- [ ] Scenario **#7** 'palette restart':
  - The Conduit palette row "Restart Go language server" is present.
  - Running it → a `stopped` status is observed.
  - A later F12 still navigates.
- [ ] Run `node test/e2e/run-smoke.mjs go-lsp` alone, then `goto-index`: both green.

### Slice 6: Hover and breadcrumbs

**Check:** `npx vitest run test/unit/lsp-nav.test.ts` passes (hover cases). `npm run typecheck` is green. `node test/e2e/run-smoke.mjs go-lsp` passes hover and breadcrumbs plus everything earlier.

**Parallel groups:** G1: T6.1 · G2: T6.2 · Serial: T6.3 (`app.tsx`), T6.4 (e2e)
**Claims (serial lane):** `webview/app.tsx` (T6.3), `test/e2e/go-lsp.e2e.mjs` (T6.4)

#### Task 6.1: Hover provider
**Files:** Modify `webview/lsp-nav.ts`, `test/unit/lsp-nav.test.ts`.
**Interfaces:** Produces `registerLspHoverProvider(languageIds: readonly string[]): monaco.IDisposable`. Consumes:
- from T5.2: `lspRequest(path: string, op: LspOp, pos: LspPosition, requestId: string): Promise<LspReply>`, `flushPending(path: string): Promise<void>`, `isLspDocOpen(path: string): boolean`, `currentVersion(path: string): number | null`;
- from T5.4: `lspToMonacoRange(r: LspRange): monaco.IRange`.

**Steps:**
- [ ] Failing tests:
  - **#11** 'hover flushes the pending change before requesting': the order is `flushPending` then `lspRequest`.
  - 'returns markdown with isTrusted false and the range'.
  - 'a peek-preview model (not an open doc) returns null without a request'.
  - 'token cancellation sends lsp:cancel'.
  - 'empty/unavailable → null, no toast'.
  - 'registers one provider per language id'.
- [ ] Run: FAIL. Implement.

#### Task 6.2: Breadcrumbs for server languages
**Files:** Modify `webview/components/breadcrumb-bar.tsx`.
**Interfaces:** Consumes:
- from T5.2: `lspRequest(path, 'documentSymbol', {line:0,character:0}, id)`, `currentVersion(path): number | null`, `subscribeLspDocSent(cb: (path: string) => void): () => void`, `serverKeyForDoc(path): string | null`;
- from T5.1: `subscribeLspStatus(cb: () => void): () => void`, `lspStateForKey(serverKey: string | null): LspDocState | null`, `hasLanguageServer(languageId: string): boolean`.

Behaviour when `hasLanguageServer(language)`:
- Fetch on mount or path change, on this key's transition to `ready`, and 500 ms after the last `subscribeLspDocSent` for the path.
- The cursor subscriber never refetches; it only recomputes the chain from the held tree.
- A reply whose version ≠ `currentVersion` is dropped.
- The TS path is unchanged. The symbol-jump dropdown (`:174-196`) is unchanged.

**Steps:**
- [ ] `npm run typecheck` green; behaviour is proven by T6.4.

#### Task 6.3: Hover registration
**Files:** Modify `webview/app.tsx`. Add an effect over `languages = useLspLanguages()` that registers `registerLspHoverProvider(languages.map(l => l.languageId))` and disposes the previous registration when the list changes.
**Interfaces:** Consumes `registerLspHoverProvider` (T6.1) and `useLspLanguages` (T5.1).
**Steps:**
- [ ] `npm run typecheck && npm run build` green.

#### Task 6.4: e2e hover and breadcrumbs
**Files:** Modify `test/e2e/go-lsp.e2e.mjs`.
**Steps:**
- [ ] Scenario 'hover': a real mouse hover on `Greet` → `.monaco-hover` contains `Greet() string` and `Greet says hi.`.
- [ ] Scenario **E10** 'breadcrumbs': with the caret inside `func main`, the last breadcrumb symbol segment is `main`.
- [ ] Run `node test/e2e/run-smoke.mjs go-lsp` alone: green.

### Slice 7: ADR and the full gate

**Check:** `npm run verify` is green (not piped). `node test/e2e/run-smoke.mjs go-lsp` is green alone. `npm run test:smoke` is green serially. `git status` shows only intended files.

**Parallel groups:** G1: T7.1 · Serial: T7.2
**Claims (serial lane):** none

#### Task 7.1: ADR 0006
**Files:** Create `docs/adr/0006-host-side-language-servers.md` in ADR 0005's header shape: **Status:** proposed · **Date:** 2026-09-22, plus **Spec** and **Plan** links.

Sections:
- **Context.**
- **Decision:**
  - the host owns processes;
  - one server per root, with the realpath as key only and the lexical root sent;
  - code-defined registry, generic downstream;
  - client epochs;
  - ordered stop vs crash.
- **Trust:**
  - lazy auto-start;
  - `GOTOOLCHAIN=local`;
  - **non-absolute PATH entries stripped from the child env**;
  - no workspace config;
  - the rejected per-root opt-in, recorded and pending the user's call before merge.
- **Lifetime:** tabs only, not sessions; 60 s idle.
- **Consequences:**
  - stdin-EOF orphan behaviour, proven by the force-kill e2e, with the Job-object contingency;
  - diagnostics are not free.
- **Alternatives rejected:** hand-rolled framing; `vscode-languageclient`.

Code comments in `electron/lsp-*.ts` that reference the rationale point here (`// see ADR 0006 §…`).
**Steps:**
- [ ] Doc task. Proof: `ls` the spec and plan paths it cites.

#### Task 7.2: Full gate
**Steps:**
- [ ] Run `npm run verify` and fix at the source until green.
- [ ] Run the Slice 7 check, then commit (`git status` first; no CHANGELOG).

## Verification

- **Per task:** the task's test file via `npx vitest run <file>`, plus `npm run typecheck` when `src/protocol.ts`, `src/lsp-protocol.ts`, a component or `electron/main.ts` changed.
- **Per slice:** the slice **Check**, verbatim.
- **Merged tree:** in this order, one at a time on a quiet machine:
  1. `npm run verify`, never piped;
  2. `node test/e2e/run-smoke.mjs go-lsp` alone;
  3. the TS nav e2es;
  4. `npm run test:smoke`, serially.
- **Coverage map:**

  | Criterion | Proven by |
  |---|---|
  | E1, E6, E8, E9, E12, E13, E14 | units (T3.2, T2.2, T5.4) |
  | E7 | T3.2 (no spawn after quit) + T4.2 (quit and force-kill e2es) |
  | E2, E3, E4, E5, E11 | T5.4 units + T5.6 e2e |
  | E10 | T6.4 |
  | Palette | T5.6 |
  | Hover | T6.1 + T6.4 |

## Deviation rule

If a task's assumption turns out wrong, the task **stops**, and fixing the misaligned piece becomes
the work. Examples:
- `vscode-jsonrpc/node` doesn't resolve under the host tsconfig;
- `globalThis.crypto.randomUUID` is unavailable in the sandboxed preload;
- gopls rejects a capability;
- the fake child can't drive `createMessageConnection`;
- go-basics' `unsupported` shape differs from the one assumed;
- **the force-kill e2e leaves gopls alive.**

The fix is never a shim, a second copy, a special case, a widened type, a fallback, or an override
patched in place of its semantic source. Examples of what that rules out:
- a re-export of `canonicalPath` from `project-index`;
- a second open-file path for LSP languages;
- `as any` on the bridge;
- a `languageId === 'go'` check in the renderer.

The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [high] **Untrusted-repo auto-start.** The user decides this **before the branch merges to main**.
  Default taken, per the ruling: lazy auto-start with `GOTOOLCHAIN=local`, the PATH strip, and no
  workspace config. The per-root opt-in is recorded in ADR 0006.
- [high, conditional] **Windows Job object.** This becomes in-scope only if T4.2's force-kill
  scenario fails. A Job object needs a native binding (none is in the tree; `@lydell/node-pty` does
  not expose one). The build stops at T4.2 and the conductor chooses the binding before re-planning.
- [normal] Peek target models are disposed at the next LSP nav or editor dispose, because there is
  no public peek-close event.
- [normal] Windows `.cmd`/`.bat` gopls shims are unsupported (`.exe` only).
- [normal] The E7 descendant walk is Windows-only in the e2e. The POSIX kill path is unit-tested in
  T2.1.

## Review findings → where fixed

| # | Finding | Fixed in |
|---|---|---|
| 1 | Ordered exits ≠ crashes; quit can spawn | Settled "Ordered stops"; Manager invariants *Crash*/*Disposed*; T3.2 #1 tests; spec §2.2 |
| 2 | webContents.id survives reload | Settled "client epoch"; preload `LSP_EPOCH`; `parseLspEnvelope` (T1.3); Manager *Clients*; T4.1; T3.2 #2 tests; spec §2.3 |
| 3 | Non-lastWriter window stale forever | Settled "Current vs stale"; Manager *Current vs stale*; T3.2 #3 tests; spec §3.2 |
| 4 | Realpath root vs doc URIs | `ServerRoot.root`/`realRoot`, `toLexicalPath` (T1.4); Manager *Key resolution*; T3.2 #4 test; spec §2.3 |
| 5 | Replay before ready; non-live sends | Manager *Liveness*; T3.2 #5 tests; spec §2.2 |
| 6 | Force-kill e2e | T4.2 scenario; Out of scope + Decisions Needed (Job object contingency); spec §2.4, §7.2 |
| 7 | Palette in the crash slice | T5.5 palette + T5.6 scenario (moved from Slice 6); spec §2.2, §6 |
| 8 | No progress gating; cancel both phases | Settled "Requests never gated"; `request(…, {signal})` (T2.2); Manager *Requests*; T2.2 + T3.2 #8 tests; spec §2.2, §3.3 |
| 9 | Ctrl+click origin | `beginLspNav` origin; T5.4 #9 test; T5.6 Ctrl+click; spec §3.3 |
| 10 | Genuinely generic | `compileWatchGlobs`/`isRootMarker`/`languageInfo` (T1.5); watcher `filter` (T3.1); `statusSnapshot.languages`; `hasLanguageServer`/`lspLanguage` (T5.1); templated messages (T5.3); branch by `lspLanguage` (T5.4); generic palette (T5.5); spec §2.1, §3.1, §3.3 |
| 11 | Hover flush | `registerLspHoverProvider` flushes (T6.1 #11 test); spec §3.2 |
| 12 | No `exit` before tree kill | `LspServerHandle.stop` contract; T2.2 #12 tests; spec §2.4 |
| 13 | Lifetime = tabs only | Settled "Lifetime"; Manager *Lifetime*; `sessionRoots` removed; T3.2 #13 tests; ADR 0006 §Lifetime (T7.1); spec §2.2, §5, E8 |
| 14 | PATH strip + ADR trust | `childEnv` contract; T1.5 #14 test; T2.2 E9 test; ADR 0006 §Trust (T7.1); spec §3.4, §13 |

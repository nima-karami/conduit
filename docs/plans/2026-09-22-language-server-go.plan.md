# Language servers in the host (Go via gopls): implementation plan

**Spec:** `docs/specs/2026-09-22-language-server-go.md`  **Tier:** FULL

## Goal

F12, Ctrl+click, peek, references, hover and breadcrumbs work on `.go` tabs through the surfaces TS
already uses. They are answered by a user-installed gopls that the Electron host owns, spawns
safely, keeps in sync with the tabs and never leaves orphaned.

## Architecture

The host owns everything stateful: binary resolution, one process per server root, the doc sync
table, the idle/crash lifecycle, the file watcher, and the URI⇄path conversion. The renderer is a thin
client. It sends open/change/close keyed on the **tab list**, sends requests, and shows the replies
through the existing nav wrapper. Every rule that can be pure is in `src/` (URIs, root resolution,
binary search order, restart budget, LSP→Conduit conversion, message validation), so ubuntu CI can
test it in node. `electron/` has three process-facing units: `lsp-server` (one connection),
`lsp-manager` (all servers and docs) and `lsp-watcher`. Each takes its collaborators as injected
deps, so the fake-process/fake-clock tests the spec requires (E1, E6, E8, E9, E12) need no Electron.
Go navigation is **not a parallel nav path**. `runNavCommand` swaps only its *probe* for Go
(`probeLspNav`), then classifies, opens (`openLocation`) and peeks (`dispatchLocations`) exactly as TS
does. That is the seam feat/nav-history hooks.

## Data flow

```
renderer (webview/)                                   host (electron/)                         gopls
app.tsx effect on docState.docs + files
  └─ lsp-sync.reconcile(goTabs) ─ lsp:open/close ───▶ ipcMain.handle('lsp')
model.onDidChangeContent ─ 150 ms debounce ─ lsp:change ─▶  LspManager.handle(windowId, raw)
                                                      │ parseLspMessage (trust boundary)
                                                      │ per-DOC intake chain (enqueued sync, before any await)
                                                      │ resolveServerRoot → serverKey → LspServer (lazy)
                                                      │ sync table {path → text, lspVersion, lastWriter, refs by window}
                                                      └─ didOpen/didChange/didClose ─────────────▶ stdio JSON-RPC
runNavCommand (ts-nav.ts)                                                                           │
  go? ─ flushPending(path) ─ probeLspNav ─ lsp:request ─▶ same chain → server.request(op, timeout) ─▶│
         ◀── LspReply {locations+targets | hover | symbols | empty | stale | unavailable} ◀── lsp-convert
  classifyNavOutcome → openLocation (1) / dispatchLocations (peek, models from `targets`)
hover provider / breadcrumb-bar ─ lsp:request (no flush, version-checked)
lsp-status store ◀── 'lsp:status' push (broadcast) ◀── LspManager state transitions
                                                      LspWatcher (recursive fs.watch per root, 200 ms)
                                                        ├─ workspace/didChangeWatchedFiles ────────▶
                                                        └─ marker (go.mod/go.work) → re-home docs
before-quit ─────────────────────────────────────────▶ manager.killAllSync() → taskkill /T /F | kill(-pid)
```

## Settled decisions (do not re-litigate)

- **Trust (conductor ruling):** lazy auto-start on first Go tab open or first Go nav, mitigated by
  `GOTOOLCHAIN=local` (unless the user's env sets `GOTOOLCHAIN`) and **no workspace-supplied config
  of any kind**. The per-root opt-in is a recorded alternative in ADR 0006 and is not built.
- **ADR 0006 is written in this build** as `docs/adr/0006-host-side-language-servers.md`, status
  **proposed**.
- The spec's six normal decisions take its defaults: crash recovery = palette command; the watcher
  stays (didChangeWatchedFiles assumed needed, and QA's agent-edit scenario confirms it); stdin-EOF
  orphan assumption with a Job object as the follow-up; out-of-root targets open as normal writable
  tabs; idle 60 s / loading wait 90 s; hover links open through the existing external path.
- Deps: `vscode-jsonrpc` ^9.0.2 + `vscode-languageserver-protocol` ^3.18.3, **bundled** into
  `out/main.js` by esbuild. electron-builder excludes `node_modules/**` except `@lydell`
  (`package.json` `build.files`), so they must never be marked `external`.
- One server per `(languageId, realpath(root))`. Root = highest `go.work` dir, else nearest `go.mod`
  dir, else the workspace root (ad hoc). Servers are process-global. Docs are ref-counted per window.
- Full-text sync with a 150 ms debounce. A nav request flushes its tab's pending change first. Hover
  and symbols never flush and are version-checked.
- Timeouts: nav 10 s when ready, 90 s total when not ready; hover 3 s; symbols 5 s; wait-for-ready
  for hover/symbols ≤ 3 s. Idle grace 60 s. Restart 1/4/16 s, ≤ 3 per rolling 5 min. Absent verdict
  cached 30 s. Out-of-root origin LRU 2 000. Targets ≤ 200 files, ≤ 2 MB each.
- Graceful stop = `shutdown` (2 s) → `exit` notification → PID-scoped tree kill while gopls is
  alive. Quit = synchronous tree kill only. Never kill by image name.
- Messages come from the spec's §3.3 table, verbatim. A Go `none` never appends TS index notes.
  Ctrl+click is silent on absent/crashed/no-root. Nav toasts are deduped by text while one is
  visible.
- The renderer never sees a server URI. The host converts every URI to a canonical path.

**Plan-level decisions** (made here; the spec left them open or placed them differently):

- **Sync is keyed on the tab list, not on CodeViewer mount.** Only the active doc mounts
  (`webview/components/center-pane.tsx:357`, `key={activeDoc.id}`), so "tab mount → lsp:open" would
  close gopls docs on every tab switch. The owner is `webview/app.tsx`, which already derives the
  open file-path set (`app.tsx:1066-1075`). It calls `reconcileGoDocs` with the Go tabs and their
  text.
- **Doc text rule:** `text = model exists && path is dirty ? model.getValue() :
  (files.get(path)?.content ?? model?.getValue())`. A Go tab whose content has not loaded yet is
  not opened until it has. A clean inactive tab whose file an agent rewrote gets a `lsp:change`
  when the `files` map updates.
- **Ordering is a per-document intake chain**, not a per-server queue. Root resolution is async
  (`realpath`, marker stats), so a per-server queue cannot be chosen synchronously. The chain
  entry for a path is set synchronously on arrival. Only the *send* step is chained. The reply
  wait is not chained, so a slow request never blocks the next change.
- **Invoke-channel types live in `src/lsp-protocol.ts`**, following the `src/git-actions.ts`
  precedent for `ipcRenderer.invoke` channels. `src/protocol.ts` gains only the `lsp:status` push
  in `HostToWebview`.
- **Go probe inside `runNavCommand`**, rather than a separate Go nav function. The wrapper already
  owns the outcome, the reference alternative, `openLocation` and `dispatchLocations`. Duplicating
  those would fork the nav-history seam.
- **E7's PID source is `lsp:statusSnapshot`**, not a main-process global. Each status carries
  `pid`, and the e2e walks descendants with `Get-CimInstance Win32_Process`.
- **Missing-gopls e2e mechanism:** launch with `PATH=%SystemRoot%\System32;%SystemRoot%`,
  `GOPATH=<empty temp>`, `GOBIN=''`, `USERPROFILE=HOME=<empty temp>`. `go` still resolves from
  `C:\Program Files\Go\bin`. `go env GOPATH` then reports the env value (the empty dir), so every
  search location is empty. The machine-dependent paths are all overridden, so the scenario does
  not depend on Program Files being absent.
- **Windows binary candidates are `<dir>\gopls.exe` only.** The spec says "each PATHEXT ext", but
  Node refuses to spawn `.cmd`/`.bat` with `shell:false` (EINVAL since the CVE-2024-27980 fix), and
  the spec forbids a shell. See Spec staleness.

## Spec staleness

- §2.1.1 "Tab mount → `lsp:open`". Measured: only the active doc's `CodeViewer` is mounted
  (`webview/components/center-pane.tsx:357`). Plan: sync is keyed on `docState.docs` in `app.tsx`
  (decision above).
- §3.2 "Peek models … disposed when the peek closes". Measured: Monaco 0.55 exposes no public event
  for the peek/references widget closing (the only handle is the internal
  `ReferencesController`). Plan: tracked target models are disposed at the next Go nav start and
  when the editor is disposed, and only if no tab is open on that path.
- §3.4 "plus each `PATHEXT` ext on Windows". `.cmd`/`.bat` cannot be spawned without a shell. Plan:
  `.exe` only (decision above).
- §7.2 "records its PID (electronApp.evaluate in the main process)". There is no main-process handle
  to the manager from Playwright. Plan: `pid` travels in `LspServerStatus`.
- §3.1 `extraSearchDirs(): Promise<string[]>` / `childEnv(base, resolvedGoDir)`. Taking no argument
  makes them impure and untestable on CI. Plan: both take an injected `SearchContext` (Contracts),
  and the tool (`go`) lookup is the spec's `resolveToolDir`.
- The worktree base `57c1418` is behind `main` (`13e0681`, the Node-floor commits). The builder
  merges `main` and `feat/go-basics` into `feat/go-lsp` before Slice 1 (see Sibling overlap).

## Global constraints

- Gate: `npm run verify`. Exit codes are captured directly, never through a pipe or `| tail`.
  Typecheck runs both tsconfigs. `tsconfig.webview.json` includes only `webview/` plus whatever it
  imports, so **no `webview/` file may import `src/lsp-convert.ts`, `src/lsp-binary.ts`,
  `src/lsp-registry.ts` or any `vscode-*` package**. `src/lsp-protocol.ts` must stay free of them.
- Stack from the repo: Electron 43.3.0, TypeScript 7.0.2, `module: CommonJS` for the host tsconfig,
  vitest 4 (`test/unit/**/*.test.ts`, node env, `// @vitest-environment jsdom` on line 1 for DOM),
  Biome 2.5.7, fallow 3.14 (unlisted/unused deps and dead exports **gate**; duplication does not).
- **CI is ubuntu.** No pure `src/` module reads `process.platform`, `path` (default export) or
  `os`. Platform is a parameter, and joins use `path.win32`/`path.posix` chosen from it. Windows
  cases must be unit-tested so they run on Linux.
- Naming: kebab-case files; `electron/<unit>.ts` flat (siblings `project-watcher.ts`,
  `plan-watcher.ts`); `src/<topic>.ts` pure. Tests are `test/unit/<module>.test.ts`. e2e is
  `test/e2e/<name>.e2e.mjs` on `test/e2e/harness.mjs`, run alone with
  `node test/e2e/run-smoke.mjs go-lsp`, hidden, never fanned out. A PTY-looking failure is re-run
  alone on a quiet machine before anyone believes it.
- Comments explain *why* only. A decision recorded in the spec or ADR 0006 gets a one-line pointer
  (`// see ADR 0006 §2`), never a re-explanation.
- Security: `spawn` with `shell:false`, an absolute `realpath`'d binary, `cwd` = the server root,
  `windowsHide:true`. `taskkill` by absolute path (`%SystemRoot%\System32\taskkill.exe`). No
  `.conduit/*`, `.vscode/*`, `go.work` or env file is read to choose a binary, args or env.
- `node_modules` in this worktree is a **junction to the main checkout's** `node_modules`.
  `npm install` here adds the two packages there too. That is additive and expected. Never run
  `npm ci`/`npm prune` from this worktree.
- Do **not** touch `CHANGELOG.md`. Commit per slice on `feat/go-lsp`: `feat(lsp): …` /
  `test(lsp): …` / `docs(adr): …`, each ending with the session's `Co-Authored-By` line. Run
  `git status` before every commit. Scratch files go to `%TEMP%\claude-scratch\`.

## Sibling overlap (rebase map)

| File | This plan | feat/go-basics | feat/nav-history |
|---|---|---|---|
| `webview/nav-outcome.ts` | new `lsp-*` outcomes, `none.adHocRoot`, `index: … \| null`, `'cancelled'` | `unsupported` gains `languageId`, new copy | n/a |
| `test/unit/nav-outcome.test.ts` | new cases | updates the unsupported assertion | n/a |
| `webview/ts-nav.ts` | Go probe branch in `runNavCommand`; `hasCodeNavigation`; `NavDeps.gesture` | passes `languageId` into `unsupported` | `openDefinitionFile(abs, pos)` at `:150`, `:171`, `:412-413` (inside `openLocation`) |
| `webview/project-index.ts` | `canonicalPath` moves out (lines 3-21) | n/a | `setDefinitionOpener`/`openDefinitionFile` signature |
| `webview/components/code-viewer.tsx` | Ctrl+click and menu gate → `hasCodeNavigation`; `gesture:'pointer'`; `canonicalPath` import | n/a | cursor-jump listener near `:384` |
| `webview/components/breadcrumb-bar.tsx` | Go symbol source | n/a | symbol jump `:185-187` → `openDefinitionFile(path,pos)` |
| `webview/app.tsx` | Go-doc reconcile effect, `initLspClient`, palette entry, `canonicalPath` import | n/a | opener registration `~1615-1629` |
| `src/lang.ts`, `src/file-icon.ts`, `webview/monaco-languages.ts` | **not touched** | owns | n/a |

Rules for the builder: go-basics is merged in before Slice 1, so `unsupported` already carries
`languageId` when Task 5.2 runs. This plan never calls `openDefinitionFile`/`setReveal` from new
code. Every Go landing goes through `openLocation` (ts-nav) or the unchanged breadcrumb jump. When
nav-history lands later, its edits at those sites cover Go with no change here.

## Out of scope

Everything in spec §1 non-goals (diagnostics, completion, rename, formatting, workspace symbols,
installing gopls, repo-configurable servers, other languages, WSL). No persistent status chip. No
Windows Job object. No read-only tabs. `src/lang.ts`, `src/file-icon.ts`, `webview/monaco-languages.ts`
belong to go-basics. `CHANGELOG.md`.

## Contracts

### `src/canonical-path.ts` (moved verbatim from `webview/project-index.ts:3-21`)
```ts
export function canonicalPath(path: string): string;
```

### `src/lsp-uri.ts` (pure, platform-independent)
```ts
/** `G:\x`, `g:/x` → `file:///G:/x`; `/x` → `file:///x`; UNC `\\srv\share\x` → `file://srv/share/x`.
 *  Each segment is percent-encoded (encodeURIComponent, so space `#` `%` and non-ASCII are encoded; the drive colon is kept literal). */
export function pathToFileUri(path: string): string;
/** Accepts `file:///c%3A/…`, `file:///C:/…`, `file:///c:/…`, `file://srv/share/…`. Returns
 *  `canonicalPath` spelling (`C:\…`, `\\srv\share\…`, POSIX unchanged); null for any non-`file:` URI. */
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
export interface LspServerStatus {
  serverKey: string; languageId: string; root: string; state: LspServerState;
  progress?: string; pid: number | null;
}
export interface LspCalls {
  'lsp:open': { req: { path: string; languageId: string; version: number; text: string }; res: { serverKey: string | null; state: LspDocState } };
  'lsp:change': { req: { path: string; version: number; text: string }; res: { ok: boolean } };
  'lsp:close': { req: { path: string }; res: { ok: boolean } };
  'lsp:request': { req: { requestId: string; path: string; version: number; op: LspOp; line: number; character: number }; res: LspReply };
  'lsp:cancel': { req: { requestId: string }; res: { ok: boolean } };
  'lsp:statusSnapshot': { req: Record<string, never>; res: { servers: LspServerStatus[] } };
  'lsp:restart': { req: { languageId: string }; res: { ok: boolean } };
}
export type LspCallType = keyof LspCalls;
export type LspMessage<K extends LspCallType = LspCallType> = K extends LspCallType ? { type: K } & LspCalls[K]['req'] : never;
export type LspResult<K extends LspCallType> = LspCalls[K]['res'];
/** Trust boundary. Null unless: known `type`; `path` a non-empty absolute path (POSIX `/`, drive
 *  `X:\`/`X:/`, UNC `\\`); `languageId` non-empty ≤ 32 chars; `version`/`line`/`character` safe
 *  integers ≥ 0; `text` a string; `requestId` a non-empty string ≤ 64; `op` in LspOp. */
export function parseLspMessage(raw: unknown): LspMessage | null;
```
`dropped` = targets over the caps or unreadable. It is counted the same way as TS's "targets we
hold no content for" and is logged host-side only.

`src/protocol.ts` `HostToWebview` gains `| { type: 'lsp:status'; status: LspServerStatus }`.

### `src/lsp-binary.ts` + `src/lsp-registry.ts` (pure; all I/O injected)
```ts
// lsp-binary.ts
export type HostPlatform = 'win32' | 'darwin' | 'linux';
export interface SearchContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: HostPlatform;
  homedir: string;
  tmpdir: string;
  isFile(p: string): Promise<boolean>;          // regular file (stat), false on any error
  realpath(p: string): Promise<string>;
  execFile(file: string, args: readonly string[], opts: { cwd: string; env: Record<string, string | undefined>; timeout: number }): Promise<string>;
}
/** Absolute, non-empty PATH entries (`;` on win32, `:` otherwise; env key matched case-insensitively on win32). */
export function pathDirs(ctx: Pick<SearchContext, 'env' | 'platform'>): string[];
/** First `<dir>/<name>` (win32: `<dir>\<name>.exe`) that isFile, realpath'd; null if none. */
export function findBinary(name: string, dirs: readonly string[], ctx: SearchContext): Promise<string | null>;
export interface ResolvedServer { binary: string; toolDir: string | null }
export function resolveServerBinary(spec: LanguageServerSpec, ctx: SearchContext): Promise<ResolvedServer | null>;

// lsp-registry.ts
export interface LanguageServerSpec {
  languageId: string; displayName: string; binary: string; args: readonly string[];
  rootMarkers: { workspace: readonly string[]; module: readonly string[] };
  watchGlobs: readonly string[]; installHint: string;
  /** Dir of the toolchain binary the server needs (`go`), or null. Searched on PATH, then GO_FIXED_DIRS[platform]. */
  resolveToolDir(ctx: SearchContext): Promise<string | null>;
  /** $GOBIN; each $GOPATH entry + `bin`; `go env GOPATH` + `bin` (only when toolDir, cwd = ctx.tmpdir,
   *  env GOTOOLCHAIN=local, timeout 5 000); homedir/go/bin. Empty values skipped. */
  extraSearchDirs(ctx: SearchContext, toolDir: string | null): Promise<string[]>;
  /** Copy of base; toolDir prepended to the PATH key (existing key casing kept on win32);
   *  GOTOOLCHAIN='local' unless base.GOTOOLCHAIN is a non-empty string. */
  childEnv(base: Readonly<Record<string, string | undefined>>, toolDir: string | null): Record<string, string | undefined>;
}
export const GO_FIXED_DIRS: Readonly<Record<HostPlatform, readonly string[]>>; // darwin: /usr/local/go/bin, /opt/homebrew/bin; linux: /usr/local/go/bin; win32: C:\Program Files\Go\bin
export const GO_SERVER: LanguageServerSpec;       // 'go', 'Go', 'gopls', [], {['go.work'],['go.mod']}, ['**/*.go','**/go.mod','**/go.sum','**/go.work'], 'go install golang.org/x/tools/gopls@latest'
export const LANGUAGE_SERVERS: readonly LanguageServerSpec[]; // [GO_SERVER]
export function serverSpecFor(languageId: string): LanguageServerSpec | null;
```

### `src/lsp-root.ts` (pure)
```ts
export interface RootProbe { exists(p: string): Promise<boolean>; realpath(p: string): Promise<string> }
export interface ServerRoot { key: string; root: string; workspaceRoot: string; adHoc: boolean }
/** Deepest workspace root containing filePath (case-insensitive on win32). Walk dirname(file) up to it:
 *  highest dir holding a workspace marker, else nearest holding a module marker, else the workspace
 *  root (adHoc). root = canonicalPath(realpath(dir)). Null when no workspace root contains the file. */
export function resolveServerRoot(filePath: string, workspaceRoots: readonly string[], spec: Pick<LanguageServerSpec, 'languageId' | 'rootMarkers'>, probe: RootProbe, platform: HostPlatform): Promise<ServerRoot | null>;
export function serverKeyFor(languageId: string, root: string): string; // `${languageId}:${root}`
export function isWithin(child: string, parent: string, platform: HostPlatform): boolean; // equal counts; case-insensitive on win32
```

### `src/lsp-restart-budget.ts` (pure)
```ts
export const RESTART_DELAYS_MS: readonly [1000, 4000, 16000];
export const RESTART_WINDOW_MS = 300_000;
/** history = restart timestamps. Drops those older than the window; null when 3 remain. */
export function nextRestart(history: readonly number[], now: number): { delayMs: number; history: number[] } | null;
```

### `src/lsp-convert.ts` (host only; types from `vscode-languageserver-protocol`)
```ts
export function toLocations(result: Location | Location[] | LocationLink[] | null | undefined): { path: string; range: LspRange }[]; // LocationLink → targetUri + targetSelectionRange; non-file dropped; deduped
export function toHover(h: Hover | null | undefined): { markdown: string; range?: LspRange } | null; // MarkupContent value; MarkedString[] joined by "\n\n" (language strings fenced)
export function toNavTree(symbols: DocumentSymbol[] | SymbolInformation[] | null | undefined, text: string, fileName: string): NavTreeNode; // root {text:fileName, kind:'module', spans:[{start:0,length:text.length}]}
export function offsetAt(text: string, pos: LspPosition): number;  // clamps past-EOL / past-EOF
export function symbolKindName(kind: number): string;
```
`symbolKindName` map: Class 5 / Struct 23 → `class`; Method 6 / Constructor 9 → `method`; Property
7 / Field 8 → `property`; Enum 10 → `enum`; Interface 11 → `interface`; Function 12 → `function`;
Variable 13 → `variable`; Constant 14 → `const`; EnumMember 22 → `enum member`; TypeParameter 26 →
`type parameter`; everything else → `''`. `SymbolInformation[]` (flat) maps to a one-level tree
using `location.range`.

### `electron/process-tree.ts`
```ts
export interface TreeKillDeps { platform: NodeJS.Platform; systemRoot: string; execFile: typeof import('node:child_process').execFile; execFileSync: typeof import('node:child_process').execFileSync; kill: (pid: number, signal: NodeJS.Signals) => void }
/** win32: `<systemRoot>\System32\taskkill.exe /PID <pid> /T /F`; posix: kill(-pid,'SIGKILL'). Resolves on completion; never rejects (logs by returning false). */
export function killTree(pid: number, deps: TreeKillDeps): Promise<boolean>;
export function killTreeSync(pid: number, deps: TreeKillDeps): boolean;
export function defaultTreeKillDeps(): TreeKillDeps;
```

### `electron/lsp-server.ts`
```ts
export interface ChildLike extends NodeJS.EventEmitter { pid?: number; stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }
export type SpawnFn = (file: string, args: readonly string[], opts: { cwd: string; env: Record<string, string | undefined>; shell: false; windowsHide: true; stdio: 'pipe'; detached: boolean }) => ChildLike;
export interface StartServerOptions {
  spec: LanguageServerSpec; binary: string; toolDir: string | null; root: string; hostEnv: Record<string, string | undefined>;
  platform: NodeJS.Platform; spawn: SpawnFn; tree: TreeKillDeps; log: LspLog;
}
export type LspLog = Pick<Logger, 'info' | 'warn' | 'error'>;   // electron/logger.ts
export class LspRequestError extends Error { constructor(readonly reason: 'timeout' | 'server-error' | 'cancelled', detail?: string) }
export interface LspServerHandle {
  readonly pid: number | null;
  /** Resolves after initialize → initialized; rejects (server-error) if initialize fails or the process exits first. */
  readonly ready: Promise<void>;
  /** True while any $/progress `begin` token is still open. */
  readonly loading: boolean;
  onProgress(cb: (loading: boolean, title: string | undefined) => void): void;
  onExit(cb: (e: { code: number | null; signal: string | null; stderrTail: string[] }) => void): void;
  notify(method: string, params: unknown): void;
  request<R>(method: string, params: unknown, timeoutMs: number, requestId?: string): Promise<R>; // rejects LspRequestError; timeout sends $/cancelRequest
  cancel(requestId: string): void;
  stop(): Promise<void>;     // shutdown (2 s) → exit notify → killTree while alive
  killSync(): void;          // killTreeSync; no protocol round-trip
}
export function startLanguageServer(opts: StartServerOptions): LspServerHandle;
```
Spawn args are exactly `spawn(binary, spec.args, { cwd: root, env: spec.childEnv(hostEnv,
toolDir), shell: false, windowsHide: true, stdio: 'pipe', detached: platform !== 'win32' })`.
`initialize` params: `processId: process.pid`, `rootUri`/`workspaceFolders` from `pathToFileUri(root)`,
`clientInfo {name:'Conduit'}`, `general.positionEncodings ['utf-16']`, and the capabilities from the
spec §5 row (definition/typeDefinition/implementation with `linkSupport:true`, references, hover
`contentFormat ['markdown','plaintext']`, documentSymbol `hierarchicalDocumentSymbolSupport:true`,
`window.workDoneProgress:true`, `workspace.didChangeWatchedFiles {dynamicRegistration:false}`,
`workspace.configuration:true`, `workspace.workspaceFolders:true`). Server→client requests:
`workspace/configuration` → `params.items.map(() => null)`; `window/workDoneProgress/create`,
`client/registerCapability` → `null`; any other → `MethodNotFound`. Notifications
`window/showMessage`, `window/logMessage` → `log.info('lsp', …)`; `textDocument/publishDiagnostics`
is dropped. stderr keeps a 50-line ring and is logged on every exit.

### `electron/lsp-watcher.ts`
```ts
export interface WatchedChange { path: string; type: 1 | 2 | 3 }   // LSP FileChangeType: Created | Changed | Deleted
export interface LspWatcherHandle { close(): void }
/** Recursive fs.watch on root; drops shouldIgnoreWatchPath(rel) and names not matching the spec's
 *  watchGlobs (basename go.mod|go.sum|go.work or ext .go); coalesces 200 ms; type from stat:
 *  missing → 3, event 'rename' + exists → 1, else 2. onMarker fires when a batch holds a go.mod/go.work. */
export function watchServerRoot(root: string, onChanges: (c: WatchedChange[]) => void, onMarker: () => void, deps?: { watch?: typeof import('node:fs').watch; stat?: (p: string) => Promise<boolean>; log?: (m: string) => void }): LspWatcherHandle;
```

### `electron/lsp-manager.ts`
```ts
export interface LspManagerDeps {
  registry: readonly LanguageServerSpec[];
  platform: HostPlatform;
  workspaceRoots(): string[];                     // main.ts writeRoots
  sessionRoots(): string[];                       // mgr.list().map(s => s.projectPath)
  resolveBinary(spec: LanguageServerSpec): Promise<ResolvedServer | null>;
  resolveRoot(path: string, spec: LanguageServerSpec): Promise<ServerRoot | null>;
  startServer(o: { spec: LanguageServerSpec; resolved: ResolvedServer; root: string }): LspServerHandle;
  watchRoot(root: string, onChanges: (c: WatchedChange[]) => void, onMarker: () => void): LspWatcherHandle;
  readTarget(path: string): Promise<string | null>;  // null if > 2 MB, unreadable, or not a regular file
  broadcastStatus(s: LspServerStatus): void;
  log: LspLog;
}
export const IDLE_GRACE_MS = 60_000, ABSENT_TTL_MS = 30_000, NAV_TIMEOUT_MS = 10_000, NAV_LOADING_TIMEOUT_MS = 90_000,
  HOVER_TIMEOUT_MS = 3_000, SYMBOLS_TIMEOUT_MS = 5_000, READY_WAIT_MS = 3_000, ORIGIN_LRU_MAX = 2_000,
  TARGETS_MAX = 200;
export class LspManager {
  constructor(deps: LspManagerDeps);
  /** Validates with parseLspMessage; invalid → per-type failure ({ok:false} / {kind:'unavailable',reason:'server-error'} /
   *  {serverKey:null,state:'no-root'} / {servers:[]}). Enqueues on the doc's intake chain synchronously. */
  handle(windowId: number, raw: unknown): Promise<LspResult<LspCallType>>;
  dropWindow(windowId: number): void;             // releases every ref held by the window; replies to it are discarded
  statuses(): LspServerStatus[];
  killAllSync(): void;                            // before-quit
}
```
Invariants the manager enforces:

- **Doc table** `Map<canonicalPath, { languageId; text; lspVersion; lastWriter: {windowId; version};
  serverKey | null; refs: Map<windowId, number> }>`. `didOpen` is sent once, when the first ref
  arrives. `didClose` is sent when refs reach 0. `lspVersion` increments on every accepted change,
  from any window.
- **Stale:** a request whose `(windowId, version)` ≠ `lastWriter` → `{kind:'stale'}`. A request for
  a path not in the table → `{kind:'empty', adHocRoot:false}`.
- **Key resolution:** `resolveRoot` first. If that is null, the origin LRU (the path was named in
  an earlier reply of server K) gives K. Otherwise the doc is recorded with `serverKey:null` and
  requests reply `unavailable/no-root`.
- **Absent:** `resolveBinary` null → server state `absent` (status broadcast, `pid:null`), cached
  30 s. Docs stay in the table. After the TTL the next open/request re-probes; if gopls is found,
  it starts and replays `didOpen` for the key's docs.
- **Idle:** when a key has 0 open docs (any window) **and** no `sessionRoots()` entry `isWithin`
  the root or contains it, a 60 s timer is armed. Any open/request for the key clears it. When it
  fires: `stop()`, state `stopped`, watcher closed.
- **Crash:** an unexpected exit calls `nextRestart`. If it returns a delay: state `restarting`, and
  after the delay start again and replay `didOpen` for every doc of the key. If it returns null,
  or `initialize` failed: state `crashed`. Pending requests reject → `unavailable/server-error`.
- **Request timing:** nav ops (`definition|typeDefinition|implementation|references`) use a 10 s
  timeout if the server is `ready` when sent. Otherwise they wait for `ready` and the request,
  together, within 90 s total, and give `unavailable/loading-timeout` on expiry.
  `hover`/`documentSymbol` wait ≤ 3 s for `ready` (else `empty`), then use their own timeout (3 s /
  5 s → `unavailable/timeout`). `crashed` → `unavailable/crashed`; `absent` →
  `unavailable/missing`.
- **Locations reply:** paths come from `toLocations`. Any path outside every workspace root is
  recorded in the origin LRU. `targets` holds the distinct paths **not** open in the requesting
  window, read via `readTarget` up to 200. Paths over the cap or unreadable are dropped from
  `locations` and counted in `dropped`. An empty result gives `{kind:'empty', adHocRoot}`.
- **Re-home:** `onMarker` recomputes keys for that server's docs. For each doc that moved: `didClose`
  on the old key, `didOpen` on the new one (lazy start), and the old key goes through the idle rule.
- **restart {languageId}:** `stop()` every server of that language, clear restart histories and the
  absent cache, broadcast `stopped`. The next open/request starts fresh.
- Every state transition calls `broadcastStatus`.

### Renderer
```ts
// webview/bridge.ts (HostBridge gains lsp; fake shell when window.agentDeck is absent)
export function lspInvoke<K extends LspCallType>(msg: LspMessage<K>): Promise<LspResult<K>>;
// fake: open → {serverKey:null,state:'absent'}; request → {kind:'unavailable',reason:'missing'}; statusSnapshot → {servers:[]}; others → {ok:true}

// webview/lsp-status.ts
export function applyLspStatus(s: LspServerStatus): void;          // 'stopped' removes the entry
export function seedLspStatuses(list: readonly LspServerStatus[]): void;
export function lspStateForKey(serverKey: string | null): LspDocState | null;
export function subscribeLspStatus(cb: () => void): () => void;
export function useLspStatuses(): readonly LspServerStatus[];      // useSyncExternalStore
export function hasGoServerEntry(list: readonly LspServerStatus[]): boolean; // any languageId 'go' with state ≠ 'stopped'

// webview/lsp-sync.ts
export interface GoDocInput { path: string; text: string }
export const LSP_CHANGE_DEBOUNCE_MS = 150;
export function initLspClient(): () => void;   // statusSnapshot → seed; subscribe 'lsp:status'; monaco.editor.onDidCreateModel attach; returns disposer
export function reconcileGoDocs(docs: readonly GoDocInput[]): void;  // open new, close gone, change when text ≠ last sent
export function isGoDocOpen(path: string): boolean;
export function serverKeyForDoc(path: string): string | null;
export function flushPending(path: string): Promise<void>;          // sends the debounced change now; resolves after its invoke settles
export function currentVersion(path: string): number | null;        // last SENT version
export function subscribeGoDocSent(cb: (path: string) => void): () => void;
export function lspRequest(path: string, op: LspOp, pos: LspPosition, requestId: string): Promise<LspReply>; // uses currentVersion; path not open → {kind:'empty',adHocRoot:false}

// webview/lsp-nav.ts
export interface LspNavProbe {
  locations: monaco.languages.Location[]; timedOut: boolean;
  unavailable: 'missing' | 'crashed' | 'no-root' | 'loading-timeout' | null;
  adHocRoot: boolean; cancelled: boolean;
}
export interface LspNavGuard { readonly cancelled: boolean; readonly requestId: string; dispose(): void }
/** Cancels the previous guard (sends lsp:cancel for its requestId); cancels itself on cursor change,
 *  model change, content change or editor dispose. Also disposes the previous nav's tracked target models whose path is not an open tab. */
export function beginLspNav(editor: monaco.editor.ICodeEditor): LspNavGuard;
/** kind 'peek' asks 'definition'. flushPending first. Creates a model for each `targets` entry
 *  lacking one (language langFromPath, uri fileUri(path)) and tracks it. 'stale' → cancelled:true.
 *  'timeout'|'server-error' → timedOut:true. */
export function probeLspNav(model: monaco.editor.ITextModel, position: monaco.Position, kind: NavCommandKind, guard: LspNavGuard): Promise<LspNavProbe>;
export function lspLoadingMessage(): NavMessage;                     // inline/info "Go: loading packages…"
export function registerLspHoverProvider(): monaco.IDisposable;      // 'go'; skips non-open-tab models; token cancel → lsp:cancel; version mismatch → null
export function lspToMonacoRange(r: LspRange): monaco.IRange;        // +1 line/column
```

### `webview/nav-outcome.ts` additions
```ts
export type NavOutcome = /* existing, with go-basics' unsupported{languageId} */
  | { kind: 'none'; adHocRoot?: boolean }
  | { kind: 'lsp-missing' } | { kind: 'lsp-crashed' } | { kind: 'lsp-loading-timeout' } | { kind: 'lsp-no-root' }
  | { kind: 'cancelled' };
export interface NavClassifyInput { /* existing */ lspUnavailable: 'missing' | 'crashed' | 'no-root' | 'loading-timeout' | null; adHocRoot: boolean; cancelled: boolean }
export interface NavMessageContext { kind: NavCommandKind; word: string | null; index: { loaded; total; done; skipped; capped } | null } // null = not index-backed (Go)
```
Classification order: `!supported` → unsupported; `cancelled` → cancelled; `lspUnavailable` →
`lsp-<reason>`; `timedOut` → timed-out; then the existing rules. An empty result with `adHocRoot`
gives `{kind:'none', adHocRoot:true}`. Messages use the §3.3 text verbatim. `cancelled` → `null`.
`none` + `adHocRoot` → today's none text + `" (no go.mod found for this file)"`. `index === null`
skips both the still-indexing branch and `indexGapNote`.

### `webview/ts-nav.ts` changes
```ts
export function hasCodeNavigation(languageId: string): boolean; // TS_LANGS.has(id) || id === 'go'
export interface NavDeps { onUnresolved?: UnresolvedResolver; gesture?: 'pointer' }
```
In `runNavCommand`, when `model.getLanguageId() === 'go'`:
1. `beginLspNav(editor)`.
2. If `lspStateForKey(serverKeyForDoc(path))` ∉ {`ready`, `absent`, `crashed`, `no-root`, null},
   `showNavMessage(editor, lspLoadingMessage())`.
3. The probe is `probeLspNav`.
4. The reference alternative (`HAS_REFERENCE_ALTERNATIVE` + `atCursor`) is unchanged.
5. The miss probe is skipped (`NO_MISS`), and the hop loop runs once.
6. Classify with the lsp fields, and `index: null` in the message context.
7. `navigated` → `openLocation`; `peeked` → `dispatchLocations`.
8. With `gesture === 'pointer'`, the `lsp-missing|lsp-crashed|lsp-no-root` message is suppressed.
9. The guard is disposed in `finally`.

TS/JS behaviour is byte-for-byte unchanged.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Go tab text/version | `app.tsx` reconcile effect + model content events (`lsp-sync`) | `LspManager` doc table → gopls `didOpen/didChange/didClose` | Both |
| Unopened-file disk changes | `lsp-watcher` | gopls `didChangeWatchedFiles`; manager re-home | Both |
| Open-but-inactive tab rewritten on disk | host `fileContent` → `files` map (`app.tsx:334`) | reconcile → `lsp:change` | Consumer only. The producer is unchanged, and its dirty-buffer guard (`shouldReplaceContent`) already keeps a dirty tab's map entry, so the text rule picks the model then |
| Nav outcomes/messages | `runNavCommand` Go branch | `navOutcomeMessage`, `showNavMessage` (+ dedupe) | Both |
| `unsupported` copy | go-basics | non-Go languages. Go never reaches `unsupported`, because `supported` is true for `go` | Consumer side (Go no longer produces it) |
| Nav landing in another file | `openLocation` (unchanged) | app opener → tab + reveal; nav-history later | Producer reused, not modified |
| Peek target models | `probeLspNav` | Monaco peek widget; `code-viewer.tsx:156-167` reuses a model at tab open (re-seeds if clean, fixes language) | Both. Disposal skips open-tab paths |
| Breadcrumb symbols | host `documentSymbol` → `toNavTree` | `breadcrumb-bar.tsx` → `enclosingSymbolChain` (unchanged) | Both |
| Server status | `LspManager` → `lsp:status` broadcast + `statusSnapshot` | `lsp-status` store → loading message, palette entry | Both |
| Process lifetime | `LspManager`/`lsp-server` | `before-quit` → `killAllSync`; window `destroyed`/reload → `dropWindow` | Both |
| `canonicalPath` | `src/canonical-path.ts` (moved) | `project-index.ts`, `app.tsx:120`, `code-viewer.tsx` import block, `markdown-viewer.tsx:26`, `test/unit/path-identity.test.ts:16`, new host code | All importers updated in Task 1.1 (recursive grep, including `test/`) |
| Nav menu enabled / Ctrl+click | `hasCodeNavigation` | `code-viewer.tsx` context menu (`canGoToDefinition`) and `onMouseDown` gate | Both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/canonical-path.ts` | create | `canonicalPath`, moved verbatim from `webview/project-index.ts` |
| `webview/project-index.ts` | modify | import `canonicalPath` from `src/canonical-path`; drop its own definition and `WIN_DRIVE` |
| `src/lsp-uri.ts` | create | path ⇄ `file:` URI, platform-independent |
| `src/lsp-protocol.ts` | create | invoke-channel types + `parseLspMessage` validator |
| `src/lsp-binary.ts` | create | PATH/extra-dir search, `resolveServerBinary` |
| `src/lsp-registry.ts` | create | `LanguageServerSpec`, `GO_SERVER`, `serverSpecFor` |
| `src/lsp-root.ts` | create | server root / key resolution, `isWithin` |
| `src/lsp-restart-budget.ts` | create | `nextRestart` |
| `src/lsp-convert.ts` | create | LSP shapes → `LspReply` pieces, `NavTreeNode` |
| `src/protocol.ts` | modify | `HostToWebview` `lsp:status` |
| `electron/process-tree.ts` | create | PID-scoped tree kill, async + sync |
| `electron/lsp-server.ts` | create | one gopls process + JSON-RPC connection |
| `electron/lsp-watcher.ts` | create | per-root recursive watch → changes + marker signal |
| `electron/lsp-manager.ts` | create | servers, doc table, lifecycle, request routing |
| `electron/main.ts` | modify | construct manager with real deps; `ipcMain.handle('lsp')`; window drop; `before-quit` |
| `electron/preload.ts` | modify | `lsp(msg)` → `ipcRenderer.invoke('lsp', msg)` |
| `webview/bridge.ts` | modify | `HostBridge.lsp`, `lspInvoke` + fake |
| `webview/lsp-status.ts` | create | status store + hook |
| `webview/lsp-sync.ts` | create | doc sync, debounce/flush, versions, `lspRequest` |
| `webview/lsp-nav.ts` | create | Go probe, nav guard, target models, hover provider |
| `webview/nav-outcome.ts` | modify | Go outcomes, messages, nullable index |
| `webview/ts-nav.ts` | modify | Go branch in `runNavCommand`; `hasCodeNavigation`; `NavDeps.gesture` |
| `webview/monaco-message.ts` | modify | toast-channel dedupe by text while visible |
| `webview/components/code-viewer.tsx` | modify | `hasCodeNavigation` gates; Ctrl+click passes `gesture:'pointer'`; `canonicalPath` import |
| `webview/components/breadcrumb-bar.tsx` | modify | Go symbols via `lspRequest('documentSymbol')` with the §4 refetch rule |
| `webview/components/markdown-viewer.tsx` | modify | `canonicalPath` import only |
| `webview/app.tsx` | modify | `canonicalPath` import; `initLspClient`; Go-doc reconcile effect; hover provider registration; palette entry |
| `package.json`, `package-lock.json` | modify | two dependencies |
| `docs/adr/0006-host-side-language-servers.md` | create | ADR 0006, status proposed |
| `test/unit/lsp-uri.test.ts`, `lsp-protocol.test.ts`, `lsp-binary.test.ts`, `lsp-registry.test.ts`, `lsp-root.test.ts`, `lsp-restart-budget.test.ts`, `lsp-convert.test.ts`, `process-tree.test.ts`, `lsp-server.test.ts`, `lsp-watcher.test.ts`, `lsp-manager.test.ts`, `lsp-status.test.ts`, `lsp-sync.test.ts`, `go-nav.test.ts` | create | unit coverage per task |
| `test/unit/path-identity.test.ts`, `test/unit/nav-outcome.test.ts` | modify | import path; new outcome cases |
| `test/e2e/go-lsp.e2e.mjs` | create | real-gopls scenarios on a temp module |

## Scripts

None (`SCRIPT_CANDIDATES: 0`, deliberate). The one repeated routine is writing the temp Go module.
It has a single caller (`go-lsp.e2e.mjs`), so it is a function inside that file
(`writeGoFixture(dir)`), not a script.

## Slices

### Slice 1: Pure seams and the dependency

**Check:** `npx vitest run test/unit/lsp-uri.test.ts test/unit/lsp-protocol.test.ts test/unit/lsp-binary.test.ts test/unit/lsp-registry.test.ts test/unit/lsp-root.test.ts test/unit/lsp-restart-budget.test.ts test/unit/lsp-convert.test.ts test/unit/path-identity.test.ts` is green, and `npm run typecheck` and `npm run fallow:check` are green.

**Parallel groups:** G1: T1.2, T1.3 · G2: T1.5 then T1.4 (T1.4 consumes `HostPlatform` and `LanguageServerSpec` from T1.5) · Serial: T1.1 (touches `app.tsx`), T1.6 (package files), then T1.7 (needs T1.6 + T1.2 + T1.3)
**Claims (serial lane):** `webview/app.tsx` (T1.1), `package.json`, `package-lock.json` (T1.6)

#### Task 1.1: Move `canonicalPath` to `src/`
**Files:** Create `src/canonical-path.ts`. Modify `webview/project-index.ts` (lines 3-21 out, import in), `webview/app.tsx:120`, `webview/components/code-viewer.tsx` (the `../project-index` import block), `webview/components/markdown-viewer.tsx:26`, `test/unit/path-identity.test.ts:16`.
**Interfaces:** Produces `canonicalPath(path: string): string`.
**Call sites:** the five importers above. Re-grep `canonicalPath` across `webview src electron test` before finishing. There must be **no** re-export from `project-index.ts`.
**Steps:**
- [ ] Port task: existing `test/unit/path-identity.test.ts` (import switched to `../../src/canonical-path`) stays green; `npm run typecheck` green.

#### Task 1.2: `lsp-uri`
**Files:** Create `src/lsp-uri.ts`. Test `test/unit/lsp-uri.test.ts`.
**Interfaces:** Produces `pathToFileUri`, `fileUriToPath` (Contracts). Consumes `canonicalPath(path: string): string` from `src/canonical-path.ts`.
**Steps:**
- [ ] Failing tests:
  - 'upper-cases the drive and flips separators': `pathToFileUri('g:\\a b\\c#.go') === 'file:///G:/a%20b/c%23.go'`.
  - 'POSIX path': `pathToFileUri('/home/x/ü.go') === 'file:///home/x/%C3%BC.go'`.
  - 'reverse accepts every drive spelling': `fileUriToPath('file:///c%3A/x/y.go') === 'C:\\x\\y.go'`, and the same for `file:///c:/…` and `file:///C:/…`.
  - 'UNC round-trips': `fileUriToPath('file://srv/share/a.go') === '\\\\srv\\share\\a.go'`.
  - 'non-file is null': `fileUriToPath('untitled:1') === null`.
  - 'round trip is identity for canonical paths'.
- [ ] Run: FAIL (module missing). Implement.

#### Task 1.3: `lsp-protocol`
**Files:** Create `src/lsp-protocol.ts`. Test `test/unit/lsp-protocol.test.ts`.
**Interfaces:** Produces every type in the `src/lsp-protocol.ts` Contracts block, plus `parseLspMessage(raw: unknown): LspMessage | null`. Consumes `NavTreeNode` (type) from `src/breadcrumbs.ts:111`.
**Steps:**
- [ ] Failing tests:
  - 'accepts each well-formed message type' (7 cases).
  - 'rejects a relative path': `parseLspMessage({type:'lsp:open', path:'a.go', languageId:'go', version:1, text:''}) === null`.
  - 'rejects negative or fractional line': `line:-1` → null; `character:1.5` → null.
  - 'rejects an unknown op or type'.
  - 'rejects requestId over 64 chars'.
  - 'accepts drive, POSIX and UNC absolute paths'.
- [ ] Run: FAIL. Implement.

#### Task 1.4: `lsp-root` + `lsp-restart-budget`
**Files:** Create `src/lsp-root.ts`, `src/lsp-restart-budget.ts`. Test `test/unit/lsp-root.test.ts`, `test/unit/lsp-restart-budget.test.ts`.
**Interfaces:** Produces `RootProbe`, `ServerRoot`, `resolveServerRoot`, `serverKeyFor`, `isWithin`, `RESTART_DELAYS_MS`, `RESTART_WINDOW_MS`, `nextRestart` (Contracts). Consumes `canonicalPath(path: string): string` (T1.1); `HostPlatform = 'win32' | 'darwin' | 'linux'` from `src/lsp-binary.ts` and `LanguageServerSpec` (for `Pick<…, 'languageId' | 'rootMarkers'>`) from `src/lsp-registry.ts` (T1.5).
**Steps:**
- [ ] Failing tests (root, fake probe over an in-memory set):
  - 'nearest go.mod wins': file `W/a/b/x.go`, `W/a/go.mod` → root `W/a`, `adHoc:false`.
  - 'highest go.work wins over a nearer go.mod': `W/go.work`, `W/a/go.mod` → `W`.
  - 'no marker → workspace root, adHoc': → `W`, `adHoc:true`.
  - 'deepest workspace root is used'.
  - 'outside every root → null'.
  - 'win32 containment is case-insensitive': `isWithin('g:\\P\\x','G:\\p','win32') === true`, `isWithin('/P/x','/p','linux') === false`.
  - 'key uses the realpath'd root': probe.realpath maps `W/a` → `R/a` → key `go:R/a`.
- [ ] Failing tests (budget):
  - 'delays 1s, 4s, 16s then null': three calls at t=0,1,2 s return 1000/4000/16000, and the fourth is null.
  - 'entries older than 5 min fall out': history `[0,1,2]` at now=300_001+2 → `delayMs 4000`.
- [ ] Run: FAIL. Implement.

#### Task 1.5: `lsp-binary` + `lsp-registry`
**Files:** Create `src/lsp-binary.ts`, `src/lsp-registry.ts`. Test `test/unit/lsp-binary.test.ts`, `test/unit/lsp-registry.test.ts`.
**Interfaces:** Produces `HostPlatform`, `SearchContext`, `pathDirs`, `findBinary`, `ResolvedServer`, `resolveServerBinary`, `LanguageServerSpec`, `GO_FIXED_DIRS`, `GO_SERVER`, `LANGUAGE_SERVERS`, `serverSpecFor` (Contracts). `resolveServerBinary` does: `toolDir = await spec.resolveToolDir(ctx)`; `dirs = [...pathDirs(ctx), ...await spec.extraSearchDirs(ctx, toolDir)]`; `binary = await findBinary(spec.binary, dirs, ctx)`; null if none.
**Steps:**
- [ ] Failing tests (fake ctx):
  - 'relative and empty PATH entries are skipped': `PATH=';.;C:\\go\\bin'` win32 → `['C:\\go\\bin']`.
  - 'win32 reads Path case-insensitively'.
  - 'win32 candidate is name.exe only': a `gopls.cmd` present, no `.exe` → null.
  - 'first regular file wins and is realpath'd'.
  - 'search order is PATH, GOBIN, GOPATH entries, go env GOPATH, ~/go/bin'. Assert the order of `isFile` calls.
  - 'go env runs in tmpdir with GOTOOLCHAIN=local and 5 s timeout'. Assert the `execFile` args.
  - 'go env failure is not fatal'.
  - 'finds go in GO_FIXED_DIRS when PATH lacks it'.
  - 'childEnv prepends toolDir and sets GOTOOLCHAIN=local'.
  - 'childEnv keeps a user GOTOOLCHAIN': base `GOTOOLCHAIN:'go1.24.0'` → unchanged.
  - 'childEnv never mutates base'.
  - 'serverSpecFor("gomod") is null'.
- [ ] Run: FAIL. Implement.

#### Task 1.6: Add the protocol dependency
**Files:** Modify `package.json` (`dependencies`: `"vscode-languageserver-protocol": "^3.18.3"`) and `package-lock.json` (via `npm install vscode-languageserver-protocol@^3.18.3`). `vscode-jsonrpc` is listed by T2.2, which is its first importer. Listing it here would leave an unused dependency for fallow until Slice 2.
**Steps:**
- [ ] Port-style task. Proof: `npm run fallow:check` is green once T1.7 imports it. Run fallow after T1.7, not before.

#### Task 1.7: `lsp-convert`
**Files:** Create `src/lsp-convert.ts`. Test `test/unit/lsp-convert.test.ts`.
**Interfaces:** Produces `toLocations`, `toHover`, `toNavTree`, `offsetAt`, `symbolKindName` (Contracts). Consumes `fileUriToPath(uri: string): string | null` (T1.2), `LspRange`/`LspPosition` (T1.3), `NavTreeNode` from `src/breadcrumbs.ts`. Imports **types** plus `SymbolKind` from `vscode-languageserver-protocol`.
**Steps:**
- [ ] Failing tests:
  - 'LocationLink uses targetSelectionRange'.
  - 'upper-case drive URIs from gopls map to canonical paths': `file:///C:/m/a.go` → `C:\\m\\a.go`.
  - 'non-file locations are dropped'.
  - 'duplicate locations collapse'.
  - 'MarkupContent hover passes through'.
  - 'MarkedString array is joined with fenced code'.
  - 'hierarchical symbols keep nesting and offsets': a struct with a method; `spans[0].start === offsetAt(text, range.start)`.
  - 'flat SymbolInformation becomes one level'.
  - 'unknown kind maps to empty string'.
  - 'offsetAt clamps past end of line and file'.
  - 'CRLF text offsets count the \\r'.
- [ ] Run: FAIL. Implement. `npm run fallow:check` green.

### Slice 2: One server process

**Check:** `npx vitest run test/unit/process-tree.test.ts test/unit/lsp-server.test.ts` is green, and `npm run typecheck` and `npm run fallow:check` are green.

**Parallel groups:** G1: T2.1 · Serial: T2.2 (consumes T2.1)
**Claims (serial lane):** `package.json`, `package-lock.json` (T2.2)

#### Task 2.1: `process-tree`
**Files:** Create `electron/process-tree.ts`. Test `test/unit/process-tree.test.ts`.
**Interfaces:** Produces `TreeKillDeps`, `killTree`, `killTreeSync`, `defaultTreeKillDeps` (Contracts).
**Steps:**
- [ ] Failing tests:
  - 'win32 runs taskkill by absolute path with /T /F': `execFile` called with `('C:\\Windows\\System32\\taskkill.exe', ['/PID','123','/T','/F'])`.
  - 'posix kills the negative pid': `kill(-123,'SIGKILL')`.
  - 'sync variant uses execFileSync'.
  - 'an exec failure resolves false, never throws'.
- [ ] Run: FAIL. Implement.

#### Task 2.2: `lsp-server`
**Files:** Create `electron/lsp-server.ts`. Modify `package.json` (`dependencies`: `"vscode-jsonrpc": "^9.0.2"`) and `package-lock.json` (`npm install vscode-jsonrpc@^9.0.2`; `npm ls vscode-jsonrpc` must show a single deduped 9.0.2, shared with the protocol package). Test `test/unit/lsp-server.test.ts`. The fake child is an EventEmitter with PassThrough stdin/stdout/stderr. A peer `createMessageConnection` on the other ends acts as a scripted LSP server.
**Interfaces:** Produces `ChildLike`, `SpawnFn`, `StartServerOptions`, `LspLog`, `LspRequestError`, `LspServerHandle`, `startLanguageServer` (Contracts). Consumes `LanguageServerSpec` (`childEnv`, `args`) from `src/lsp-registry.ts`, `pathToFileUri` (T1.2), `killTree`/`killTreeSync`/`TreeKillDeps` (T2.1). Imports `createMessageConnection`, `StreamMessageReader`, `StreamMessageWriter` from `vscode-jsonrpc/node`.
**Steps:**
- [ ] Failing tests:
  - **E9** 'spawns the resolved absolute binary with no shell, cwd = root, detached only on posix, GOTOOLCHAIN=local': assert the `SpawnFn` args exactly.
  - 'ready resolves after initialize and sends initialized': the peer sees `initialize` with `rootUri` = `pathToFileUri(root)` and `hierarchicalDocumentSymbolSupport:true`.
  - 'initialize error rejects ready'.
  - 'progress begin/end toggles loading and calls onProgress'.
  - 'workspace/configuration answers one null per item'.
  - 'unknown server request gets MethodNotFound'.
  - 'publishDiagnostics is dropped, showMessage is logged'.
  - 'request timeout rejects LspRequestError("timeout") and sends $/cancelRequest' (fake timers).
  - 'cancel(requestId) sends $/cancelRequest for that id'.
  - 'exit fires onExit with the last 50 stderr lines'.
  - 'stop sends shutdown then exit then killTree while alive': the order is asserted, and a peer ignoring `shutdown` still gets killed after 2 s.
  - 'killSync calls killTreeSync with the pid'.
- [ ] Run: FAIL. Implement.

### Slice 3: Manager and watcher

**Check:** `npx vitest run test/unit/lsp-watcher.test.ts test/unit/lsp-manager.test.ts` is green, and `npm run typecheck` is green.

**Parallel groups:** G1: T3.1 · Serial: T3.2 (consumes T3.1)
**Claims (serial lane):** none

#### Task 3.1: `lsp-watcher`
**Files:** Create `electron/lsp-watcher.ts`. Test `test/unit/lsp-watcher.test.ts` (injected `watch` and `stat`, fake timers).
**Interfaces:** Produces `WatchedChange`, `LspWatcherHandle`, `watchServerRoot` (Contracts). Consumes `shouldIgnoreWatchPath(rel: string): boolean` from `src/watch-filter.ts:30`.
**Steps:**
- [ ] Failing tests:
  - 'only .go, go.mod, go.sum, go.work pass': `x.ts` is ignored.
  - 'node_modules and .git noise are ignored'.
  - 'a burst within 200 ms becomes one batch with the last type per path'.
  - 'deleted file reports type 3, created 1, modified 2'.
  - 'go.mod in a batch fires onMarker once'.
  - 'close stops the fs watcher and the pending timer'.
  - 'watch error closes and logs, no throw'.
- [ ] Run: FAIL. Implement (recursive `fs.watch`, as `electron/project-watcher.ts:38` does).

#### Task 3.2: `lsp-manager`
**Files:** Create `electron/lsp-manager.ts`. Test `test/unit/lsp-manager.test.ts`. A fake `LspServerHandle` records notifies/requests, exposes `resolveReady()`, `emitExit()`, `emitProgress()`, and answers requests from a script. Uses `vi.useFakeTimers()`.
**Interfaces:** Produces `LspManagerDeps`, the timing constants, `LspManager` (Contracts). Consumes `parseLspMessage` and every type in `src/lsp-protocol.ts` (T1.3); `ServerRoot`, `isWithin` (T1.4); `nextRestart` (T1.4); `LanguageServerSpec`, `ResolvedServer` (T1.5); `toLocations`, `toHover`, `toNavTree` (T1.7); `LspServerHandle`, `LspRequestError`, `LspLog` (T2.2); `WatchedChange`, `LspWatcherHandle` (T3.1).
**Steps:**
- [ ] Failing tests (each names its spec criterion):
  - **E1** 'two docs under one module from two windows share one server and one didOpen each': `startServer` called once.
  - **E1** 'two modules without go.work get two servers'.
  - 'invalid message → typed failure, no server started'.
  - 'open/change/request for one path reach the server in arrival order even though root resolution is async': `resolveRoot` resolves after 50 ms, and the `didChange` precedes the `definition` request.
  - 'request with an old version → stale'. 'request from the non-last-writer window → stale'.
  - 'nav while loading waits and answers after progress end'.
  - 'nav while starting times out at 90 s → loading-timeout'.
  - 'ready nav times out at 10 s → timeout'.
  - 'hover while starting waits ≤ 3 s then empty'.
  - **E5** 'missing binary → absent status, request → missing; open still ok'.
  - 'absent verdict cached 30 s, re-probe finds the binary, starts and replays didOpen for open docs'.
  - **E6** 'unexpected exit restarts after 1 s replaying didOpen; 4th exit in 5 min → crashed; request → crashed'.
  - 'restart {languageId} stops all, clears budget and absent cache, broadcasts stopped'.
  - **E8** 'no docs and no related session for 60 s → stop(); a session whose projectPath contains the root keeps it alive; an open before 60 s cancels'.
  - 'dropWindow releases refs; didClose when last ref goes'.
  - 'locations reply: out-of-root target path recorded; a later open of that path attaches to that server'.
  - 'targets exclude paths open in the requesting window; over 200 or unreadable are dropped and counted'.
  - 'empty result under an ad-hoc root → {kind:"empty", adHocRoot:true}'.
  - 'marker event re-homes a doc: didClose old key, didOpen new key'.
  - 'watcher changes forward as workspace/didChangeWatchedFiles with pathToFileUri URIs'.
  - 'documentSymbol reply is a NavTreeNode built from the synced text'.
  - **E7 (unit half)** 'killAllSync calls killSync on every live server'.
  - 'every transition broadcasts a status with pid'.
- [ ] Run: FAIL. Implement.

### Slice 4: Host wiring

**Check:** `npm run typecheck && npm run build` pass. Then `node test/e2e/run-smoke.mjs go-lsp` passes the two host-level scenarios created here. The fixture needs gopls on the machine; the precondition is stated in the scenario.

**Parallel groups:** Serial: T4.1 → T4.2
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `electron/preload.ts` (T4.1); `test/e2e/go-lsp.e2e.mjs` (T4.2)

#### Task 4.1: Wire manager, IPC, preload
**Files:** Modify `src/protocol.ts` (`HostToWebview`), `electron/main.ts`, `electron/preload.ts`.
**Interfaces:**
- Produces: preload `api.lsp(msg: LspMessage): Promise<LspResult<LspCallType>>`, which is `ipcRenderer.invoke('lsp', msg)`; `HostToWebview` `{ type: 'lsp:status'; status: LspServerStatus }`.
- Consumes: `LspManager`, `LspManagerDeps` (T3.2); `resolveServerBinary`, `SearchContext`, `LANGUAGE_SERVERS` (T1.5); `resolveServerRoot` (T1.4); `startLanguageServer` (T2.2); `defaultTreeKillDeps` (T2.1); `watchServerRoot` (T3.1).

main.ts specifics:
- Construct the manager inside `app.whenReady` **after** `writeRoots` is defined (`electron/main.ts:3412`). Its deps are:
  - `workspaceRoots: writeRoots`
  - `sessionRoots: () => mgr.list().map(s => s.projectPath)`
  - `broadcastStatus: s => broadcast({type:'lsp:status', status:s})`
  - `readTarget`: `fs.promises.stat` (regular file, ≤ 2 MB) + `readFile(utf8)`
  - `resolveBinary`: `resolveServerBinary(spec, ctx)`. `ctx` has `process.env`; `process.platform`; `os.homedir()`; `os.tmpdir()`; `isFile` via `fs.promises.stat().isFile()`; `fs.promises.realpath`; `execFile` promisified with `windowsHide:true`.
  - `resolveRoot`: `resolveServerRoot(path, writeRoots(), spec, {exists, realpath}, process.platform)`
  - `startServer`: `startLanguageServer({ …, spawn: child_process.spawn, tree: defaultTreeKillDeps(), hostEnv: process.env, platform: process.platform })`
  - `watchRoot`: `watchServerRoot`
  - `log`
- `ipcMain.handle('lsp', (e, raw) => { trackSender(e.sender); return manager.handle(e.sender.id, raw); })`. `trackSender` attaches once per webContents: `'destroyed'` → `dropWindow(id)`, and `'did-start-navigation'` with `isMainFrame && !isSameDocument` → `dropWindow(id)`, which covers a reload.
- In `before-quit`, add `lspManager.killAllSync()` next to `pty.disposeAll()` (`electron/main.ts:3607-3647`).
- A reply to a destroyed sender is dropped by `ipcMain.handle`. The manager additionally ignores ref ops from a dropped window id.

**Steps:**
- [ ] `npm run typecheck && npm run build` green. This is a wiring task; behaviour is proven by T4.2 and Slice 3's units.

#### Task 4.2: e2e scaffold, host-level scenarios
**Files:** Create `test/e2e/go-lsp.e2e.mjs`.
**Interfaces:** Consumes the harness (`launchApp`, `openSession`, `closeApp`, `runScenario`, `assert`) and `window.agentDeck.lsp` (T4.1).
**Fixture:** `writeGoFixture(dir)` writes:
- `go.mod`: `module example.com/fix\n\ngo 1.22\n`.
- `main.go`: package main; imports `example.com/fix/pkg/util`; `func main() { helper(); _ = util.Greet() }`.
- `helper.go`: `func helper() {}`.
- `pkg/util/util.go`: `// Greet says hi.\nfunc Greet() string { return "hi" }`.

The temp dir is `mkdtempSync(join(tmpdir(), 'conduit-go-'))`.

**Precondition:** before launching, resolve `gopls` the way the host does (`where gopls` or `%USERPROFILE%\go\bin\gopls.exe`). If it is absent, fail with `go-lsp e2e needs gopls: go install golang.org/x/tools/gopls@latest` rather than skip silently.
**Steps:**
- [ ] Scenario 'host: definition across files via the bridge':
  - `openSession(page,{path:fixture})`.
  - `window.agentDeck.lsp({type:'lsp:open', path:main.go, languageId:'go', version:1, text})`.
  - Poll `lsp:statusSnapshot` until state `ready` (ceiling 120 s).
  - `lsp:request definition` at `helper` → `kind:'locations'`, path ends with `helper.go`, `range.start.line === 2`.
- [ ] Scenario **E7** 'no orphans':
  - Record `pid` from the snapshot and every descendant (PowerShell `Get-CimInstance Win32_Process` walk on `ParentProcessId`).
  - `closeApp(app, page)`.
  - Poll up to 5 s: `process.kill(pid, 0)` throws for every recorded PID.
- [ ] Run `node test/e2e/run-smoke.mjs go-lsp` alone: green.

### Slice 5: Go navigation in the editor

**Check:**
- `npx vitest run test/unit/lsp-status.test.ts test/unit/lsp-sync.test.ts test/unit/go-nav.test.ts test/unit/nav-outcome.test.ts test/unit/nav-failure.test.ts` is green.
- `npm run typecheck` is green.
- `node test/e2e/run-smoke.mjs go-lsp` passes: definition in-package (F12), definition cross-package (Ctrl+click), references peek, agent-edits-unopened-file, gopls missing.
- `node test/e2e/run-smoke.mjs goto-index` (the TS regression) is still green.

**Parallel groups:** G1: T5.1 · G2: T5.3 · Serial: T5.0 (bridge), then T5.2 (consumes 5.0 + 5.1), T5.4 (consumes 5.2 + 5.3), T5.5 (`code-viewer.tsx` + `app.tsx`), T5.6 (e2e)
**Claims (serial lane):** `webview/bridge.ts` (T5.0), `webview/app.tsx` (T5.5), `test/e2e/go-lsp.e2e.mjs` (T5.6)

#### Task 5.0: Bridge
**Files:** Modify `webview/bridge.ts` (`HostBridge` gains `lsp(msg: LspMessage): Promise<LspResult<LspCallType>>`; new export).
**Interfaces:** Produces `lspInvoke<K extends LspCallType>(msg: LspMessage<K>): Promise<LspResult<K>>`. When the host is absent, the fake from Contracts applies: open → `{serverKey:null, state:'absent'}`; request → `{kind:'unavailable', reason:'missing'}`; statusSnapshot → `{servers:[]}`; others → `{ok:true}`. The single cast from `LspResult<LspCallType>` to `LspResult<K>` sits at this one boundary, the same way `ts-nav.ts:182` casts across the worker boundary.
**Steps:**
- [ ] `npm run typecheck` green; behaviour is proven by T5.2's tests, which mock this module.

#### Task 5.1: Status store
**Files:** Create `webview/lsp-status.ts`. Test `test/unit/lsp-status.test.ts`.
**Interfaces:** Produces `applyLspStatus`, `seedLspStatuses`, `lspStateForKey`, `subscribeLspStatus`, `useLspStatuses`, `hasGoServerEntry` (Contracts). Consumes `LspServerStatus`, `LspDocState` (T1.3).
**Steps:**
- [ ] Failing tests:
  - 'stopped removes the entry'.
  - 'later status replaces earlier for the same key'.
  - 'hasGoServerEntry is true for absent and crashed, false for none'.
  - 'lspStateForKey(null) is null'.
- [ ] Run: FAIL. Implement.

#### Task 5.2: `lsp-sync`
**Files:** Create `webview/lsp-sync.ts`. Test `test/unit/lsp-sync.test.ts`. It mocks `../../webview/bridge` (`lspInvoke`, `subscribe`) and uses a minimal `monaco-editor` mock as in `test/unit/nav-failure.test.ts:34-52`, with `onDidCreateModel` and `getModel`.
**Interfaces:** Produces `GoDocInput`, `LSP_CHANGE_DEBOUNCE_MS`, `initLspClient`, `reconcileGoDocs`, `isGoDocOpen`, `serverKeyForDoc`, `flushPending`, `currentVersion`, `subscribeGoDocSent`, `lspRequest` (Contracts). Consumes `lspInvoke` (T5.0); `seedLspStatuses`, `applyLspStatus` (T5.1); `fileUri` from `webview/project-index.ts`; `subscribe` from `webview/bridge.ts`.
**Steps:**
- [ ] Failing tests:
  - 'reconcile opens new Go docs with version 1 and closes removed ones'.
  - 'unchanged text sends nothing'.
  - 'model edits debounce to one lsp:change at 150 ms with version+1'.
  - 'flushPending sends immediately and resolves after the invoke'.
  - 'a request carries the last sent version'.
  - 'a request for a path not open resolves empty without invoking'.
  - 'open reply records serverKey'.
  - 'only models whose uri equals fileUri(tab path) are attached': a same-path diff model with a different URI is ignored.
  - 'subscribeGoDocSent fires after each sent change'.
  - 'initLspClient seeds from statusSnapshot and applies lsp:status pushes'.
- [ ] Run: FAIL. Implement.

#### Task 5.3: Outcomes, messages, toast dedupe
**Files:** Modify `webview/nav-outcome.ts`, `webview/monaco-message.ts`, `webview/ts-nav.ts` (only the three call sites below), `test/unit/nav-outcome.test.ts`.
**Interfaces:** Produces the `NavOutcome` additions, the `NavClassifyInput` fields (`lspUnavailable`, `adHocRoot`, `cancelled`) and `NavMessageContext.index: … | null` (Contracts). `showNavMessage` skips `pushToast` when `getToastsSnapshot().some(t => t.message === message.text)`.
**Call sites:**
- `classifyNavOutcome` at `webview/ts-nav.ts:538`. This task passes `lspUnavailable:null, adHocRoot:false, cancelled:false` so the tree typechecks; T5.4 gives the Go branch its real values.
- `navOutcomeMessage` at `webview/ts-nav.ts:584` and `:598`. They are unchanged in shape (TS keeps passing `indexStatus()`).
- Existing tests in `test/unit/nav-outcome.test.ts` pass the new fields as `null/false/false`.

**Parallel note:** this task edits `ts-nav.ts` at three lines. T5.4 also edits `ts-nav.ts`, and T5.4 is serial after this task, so G2 (this task) must finish before T5.4 starts.
**Steps:**
- [ ] Failing tests:
  - 'each lsp reason classifies to its outcome and message': the exact §3.3 strings, including the curly quotes around “Restart Go language server”.
  - 'cancelled has no message'.
  - 'Go none with adHocRoot appends the go.mod note'.
  - 'index null skips the still-indexing branch and gap note'.
  - 'lsp reasons outrank timedOut'.
  - 'showNavMessage toast is deduped while visible, and pushes again after dismiss' (`__resetToastsForTest`).
- [ ] Run: FAIL. Implement.

#### Task 5.4: `lsp-nav` + the Go branch in `runNavCommand`
**Files:** Create `webview/lsp-nav.ts`. Modify `webview/ts-nav.ts`. Test `test/unit/go-nav.test.ts`. The test mirrors `test/unit/nav-failure.test.ts`'s monaco mock (adding `onDidChangeCursorPosition`, `onDidChangeModel`, `onDidChangeModelContent` and `onDidDispose` on the fake editor), mocks `../../webview/lsp-sync` (`lspRequest`, `flushPending`, `serverKeyForDoc`, `isGoDocOpen`) and `../../webview/lsp-status` (`lspStateForKey`), and spies `setDefinitionOpener` for the open path.
**Interfaces:**
- Produces: `LspNavProbe`, `LspNavGuard`, `beginLspNav`, `probeLspNav`, `lspLoadingMessage`, `lspToMonacoRange` (Contracts); `hasCodeNavigation(languageId: string): boolean`; `NavDeps.gesture?: 'pointer'`.
- Consumes:
  - From T5.2: `lspRequest(path: string, op: LspOp, pos: LspPosition, requestId: string): Promise<LspReply>`; `flushPending(path: string): Promise<void>`; `serverKeyForDoc(path: string): string | null`; `isGoDocOpen(path: string): boolean`.
  - From T5.1: `lspStateForKey(serverKey: string | null): LspDocState | null`.
  - From T5.3: the outcome and message types.
  - Existing modules: `langFromPath` (`src/lang.ts`); `ensureTokenizer` (`webview/monaco-languages.ts`); `fileUri`, `pathForUri` (`webview/project-index.ts`).

`registerLspHoverProvider` is **not** produced here. Its first caller is Slice 6 (T6.1).
**Call sites:** `runNavCommand` callers are unchanged (`code-viewer.tsx` navigate + Ctrl+click). `TS_LANGS` stays exported for `code-viewer.tsx` until T5.5 switches it to `hasCodeNavigation`; T5.5 removes the export if nothing else imports it (re-grep).
**Steps:**
- [ ] Failing tests:
  - **E2** 'F12 on a Go model asks lsp definition after flushing, and one other-file result opens via the definition opener with the reveal'.
  - 'many results peek via editor.action.peekLocations with models created from targets'.
  - 'definition at the cursor falls through to references'.
  - 'Alt+F12 asks definition and peeks'.
  - **E12** 'a cursor move before the reply → no open, no message, lsp:cancel sent'.
  - **E12** 'a second nav cancels the first'.
  - 'stale reply → cancelled, silent'.
  - 'loading state shows the inline loading message first'.
  - 'missing → install toast; pointer gesture → silent'.
  - 'timeout → timed-out message'.
  - 'a Go nav never calls the TS worker': `getTypeScriptWorker` is not called.
  - 'a TS nav is unchanged': reuse one existing nav-failure case shape.
  - 'target models of the previous nav are disposed unless an open tab'.
- [ ] Run: FAIL. Implement.

#### Task 5.5: Editor gates and app wiring
**Files:** Modify `webview/components/code-viewer.tsx`, `webview/app.tsx`, and `webview/ts-nav.ts` (the `TS_LANGS` export only, if it has become unused).

In `code-viewer.tsx`:
- The context-menu `canGoToDefinition` and the `onMouseDown` gate use `hasCodeNavigation`.
- Ctrl+click calls `runNavCommand(editor, 'editor.action.revealDefinition', { gesture: 'pointer' })`.

In `app.tsx`:
- An effect calls `initLspClient()` once and disposes it on unmount. It sits next to the existing `registerTsNavigationProviders` effect at `~1619-1629`.
- An effect over `[docState.docs, files]` builds the `GoDocInput[]` and calls `reconcileGoDocs`:
  - Take file-kind docs with `langFromPath(path) === 'go'`, deduped by path.
  - Text follows the rule in Settled decisions (`getDirtySnapshot()`, `monaco.editor.getModel(fileUri(path))`, `files.get(path)?.content`).
  - Paths with no text are skipped.

**Interfaces:** Consumes `hasCodeNavigation`, `NavDeps.gesture` (T5.4); `initLspClient`, `reconcileGoDocs`, `GoDocInput` (T5.2).
**Steps:**
- [ ] `npm run typecheck && npm run build` green, and `npx vitest run test/unit/editor-menu.test.ts` green (menu unchanged in shape). Behaviour is proven by T5.6.

#### Task 5.6: e2e editor scenarios
**Files:** Modify `test/e2e/go-lsp.e2e.mjs`.
**Steps:**
- [ ] Background: open `main.go` through the Explorer path the other nav e2es use (see `test/e2e/goto-index.e2e.mjs`), and wait for `lsp:status ready`.
- [ ] Scenario 'definition across files in one package': caret on `helper` in main.go, F12 → the active tab title is `helper.go` and the caret line contains `func helper`.
- [ ] Scenario 'definition across packages': Ctrl+click `Greet` (real mouse on the token's box) → the active tab is `util.go`, and the caret line contains `func Greet`.
- [ ] Scenario 'references': in helper.go, Shift+F12 on `helper` → the references peek lists 2 results (helper.go, main.go).
- [ ] Scenario **E11** 'agent edits an unopened file':
  - Close helper.go.
  - `writeFileSync(helper.go, 'package main\n\nfunc helper2() {}\n')`.
  - Edit main.go's buffer to call `helper2()`.
  - Poll up to 5 s: F12 on `helper2` lands in helper.go.
- [ ] Scenario **E5** 'gopls missing': a separate `launchApp({ env })` with the env from Settled decisions.
  - F12 on `helper` → exactly one toast with the install text.
  - No toast with variant error.
  - Typing into main.go still works (the buffer text changes).
- [ ] Run `node test/e2e/run-smoke.mjs go-lsp` alone, then `node test/e2e/run-smoke.mjs goto-index`: both green.

### Slice 6: Hover, breadcrumbs, palette restart

**Check:** `npx vitest run test/unit/go-nav.test.ts` is green (the hover cases). `npm run typecheck` is green. `node test/e2e/run-smoke.mjs go-lsp` passes the hover and breadcrumbs scenarios plus everything from Slices 4-5.

**Parallel groups:** G1: T6.1 · G2: T6.2 · Serial: T6.3 (`app.tsx`), T6.4 (e2e)
**Claims (serial lane):** `webview/app.tsx` (T6.3), `test/e2e/go-lsp.e2e.mjs` (T6.4)

#### Task 6.1: Hover provider
**Files:** Modify `webview/lsp-nav.ts`, `test/unit/go-nav.test.ts`.
**Interfaces:** Produces `registerLspHoverProvider(): monaco.IDisposable`. Consumes `lspRequest(path: string, op: LspOp, pos: LspPosition, requestId: string): Promise<LspReply>`, `isGoDocOpen(path: string): boolean`, `currentVersion(path: string): number | null` (T5.2); `lspToMonacoRange(r: LspRange): monaco.IRange` (T5.4).
**Steps:**
- [ ] Failing tests:
  - 'hover returns markdown contents with isTrusted false and the range'.
  - 'hover on a peek-preview model (not an open tab) returns null without a request'.
  - 'token cancellation sends lsp:cancel'.
  - 'empty/unavailable → null, no toast'.
- [ ] Run: FAIL. Implement.

#### Task 6.2: Breadcrumbs for Go
**Files:** Modify `webview/components/breadcrumb-bar.tsx`.
**Interfaces:** Consumes `lspRequest(path, 'documentSymbol', {line:0,character:0}, id)`, `currentVersion(path): number | null`, `subscribeGoDocSent(cb: (path: string) => void): () => void`, `serverKeyForDoc(path): string | null` (T5.2); `subscribeLspStatus(cb: () => void): () => void`, `lspStateForKey(serverKey: string | null): LspDocState | null` (T5.1).
Behaviour for `language === 'go'`:
- Fetch on mount/path change, on a status transition of this doc's key to `ready`, and 500 ms after the last `subscribeGoDocSent` for this path.
- The cursor subscriber **never** refetches for Go: it only recomputes the chain from the held tree.
- A reply whose version ≠ `currentVersion(path)` at arrival is dropped.
- TS path unchanged.
- The symbol-jump dropdown (`:174-196`) is unchanged: it already reads the tab's own model.

**Steps:**
- [ ] `npm run typecheck` green; behaviour is proven by T6.4 (the component has no unit harness today; do not add a jsdom Monaco harness for it).

#### Task 6.3: Palette entry and hover registration
**Files:** Modify `webview/app.tsx`.
- Register `registerLspHoverProvider()` in the same disposables array as `registerTsNavigationProviders()` (`~1625`).
- In `commandItems` (`~2488`), add `{ id: 'cmd:restartGoLsp', title: 'Restart Go language server', keywords: ['gopls','go','lsp'], group: 'Commands', run: () => void lspInvoke({ type: 'lsp:restart', languageId: 'go' }) }`, included only when `hasGoServerEntry(lspStatuses)`. `lspStatuses = useLspStatuses()` joins the memo deps.

**Interfaces:** Consumes `registerLspHoverProvider` (T6.1), `useLspStatuses(): readonly LspServerStatus[]`, `hasGoServerEntry(list): boolean` (T5.1), `lspInvoke<K>(msg: LspMessage<K>): Promise<LspResult<K>>` (T5.0).
**Steps:**
- [ ] `npm run typecheck && npm run build` green.

#### Task 6.4: e2e hover, breadcrumbs, palette
**Files:** Modify `test/e2e/go-lsp.e2e.mjs`.
**Steps:**
- [ ] Scenario 'hover': a real mouse hover on `Greet` in main.go → `.monaco-hover` text contains `func util.Greet() string` or `func Greet() string` (whichever gopls v0.20 prints; assert on `Greet() string`) and `Greet says hi.`.
- [ ] Scenario **E10** 'breadcrumbs': caret inside `func main` → the last breadcrumb symbol segment's text is `main`.
- [ ] Scenario 'palette restart': open the Conduit palette, and the row "Restart Go language server" is present. Run it → a status `stopped` is observed, then F12 still navigates (the server restarts lazily).
- [ ] Run `node test/e2e/run-smoke.mjs go-lsp` alone: green.

### Slice 7: ADR and the full gate

**Check:** `npm run verify` is green (not piped). `node test/e2e/run-smoke.mjs go-lsp` is green alone. `npm run test:smoke` is green serially (re-run a PTY failure alone before believing it). `git status` shows only intended files.

**Parallel groups:** G1: T7.1 · Serial: T7.2
**Claims (serial lane):** none

#### Task 7.1: ADR 0006
**Files:** Create `docs/adr/0006-host-side-language-servers.md`, following ADR 0005's header shape:
- **Status:** proposed · **Date:** 2026-09-22. **Spec** and **Plan** links.
- Sections: Context; Decision (the host owns processes; one server per root; code-defined registry; spec §3.4 security rule; `GOTOOLCHAIN=local`; lazy auto-start); Trust posture and the rejected alternative (per-root opt-in on first Go nav: recorded, not built, pending the user's call before merge); Consequences (orphan assumption → Job object follow-up; diagnostics are not free); Alternatives rejected (hand-rolled framing, `vscode-languageclient`).
- Code comments in `electron/lsp-*.ts` that reference the rationale point here (`// see ADR 0006 §…`).

**Steps:**
- [ ] Doc task: `npm run check` (Biome ignores .md; the proof is the link targets existing: `ls` both the spec and plan paths it cites).

#### Task 7.2: Full gate
**Steps:**
- [ ] `npm run verify`; fix at the source until green.
- [ ] Run the Slice 7 check; commit (`git status` first; no CHANGELOG).

## Verification

- **Per task:** the task's own test file via `npx vitest run <file>`, plus `npm run typecheck` whenever `src/protocol.ts`, `src/lsp-protocol.ts`, a component or `electron/main.ts` changed.
- **Per slice:** the slice **Check**, verbatim.
- **Merged tree:** `npm run verify` (never piped or truncated), then `node test/e2e/run-smoke.mjs go-lsp` alone on a quiet machine, then the TS nav e2es (`goto-index`, `goto-matrix-*`) one at a time, then `npm run test:smoke` serially.
- **Coverage map:**
  - E1, E6, E8, E9, E12 → units (T3.2, T2.2, T5.4).
  - E2, E3, E4, E5, E11 → T5.4 units + T5.6 e2e.
  - E7 → T3.2 unit + T4.2 e2e.
  - E10 → T6.4.
  - The hover/palette parts of §7.2 → T6.4.
  - E4's loading message → T5.4 unit ('loading state shows the inline loading message first'). The 90 s ceiling → T3.2 unit.

## Deviation rule

If a task's assumption turns out wrong, the task **stops** and fixing the misaligned piece becomes
the work. Examples: `vscode-jsonrpc/node` does not resolve under the host tsconfig; gopls rejects
a capability; the fake child cannot drive `createMessageConnection`; `did-start-navigation` does
not fire on reload; go-basics' `unsupported` shape differs from the one assumed here. The fix is
never a shim, a second copy, a special case, a widened type, a fallback, or an override patched in
place of its semantic source. Examples: a re-export of `canonicalPath` from `project-index`, a
second open-file path for Go, or `as any` on the bridge. The report leads with the fix that keeps
the locked decision.

## Decisions Needed

- [high] **Untrusted-repo auto-start**: carried from spec §13 for the user's call **before this
  branch merges to main**. Default taken: lazy auto-start with `GOTOOLCHAIN=local` and no workspace
  config. The per-root opt-in is recorded in ADR 0006 as the alternative.
- [normal] Peek target models cannot be disposed on peek close (no public Monaco event). Default
  taken: dispose at the next Go nav start or editor dispose. Worst case, a few extra models live
  until the next Go nav.
- [normal] Windows `.cmd`/`.bat` shims for gopls are not supported (Node refuses to spawn them
  without a shell). Default taken: `.exe` only. The install hint (`go install`) always produces an
  `.exe`.
- [normal] E7's descendant walk is Windows-only in the e2e (PowerShell CIM). Default taken: the
  smoke suite runs on Windows; the POSIX kill path is unit-tested in T2.1.

---
status: shipped
date: 2026-09-22
tier: FULL
type: UI + host (non-UI core)
---

# Language servers in the host — Go via gopls (v1)

**Tier:** FULL   **Feature type:** mixed — a host subsystem (process lifecycle, JSON-RPC, buffer
sync) plus UI touchpoints that reuse existing surfaces (nav outcomes, peek, hover, breadcrumbs, one
palette command).
**One-line request:** "golang support would be nice" (external user). The cheap half (go.mod grammar,
icons, generic unsupported message) is `2026-09-22-go-files-basics.md` (feat/go-basics); it lands
first or alongside. `gomod`/`plaintext` module files are never language `go`.

## 1. Problem frame
- **Job:** move around a Go codebase the way you already can in a TS one — F12, Ctrl+click, peek,
  references, hover, breadcrumbs — usually while an agent edits it under you.
- **Actors:** the user in the editor; agents writing files on disk; gopls (user-installed).
- **Success:** the TS nav gestures work on `.go` files through the same surfaces; a missing gopls gives
  one actionable message; quitting leaves no gopls behind.
- **Non-goals (v1):** diagnostics, completion, signature help, rename, code actions, formatting,
  semantic tokens, inlay hints, workspace symbols, installing gopls, repo-configurable servers, other
  languages (the registry admits them; none configured), remote/WSL paths.

## 2. Behavior & states

### 2.1 Primary flow
1. **An open Go document is a `file:` tab whose language is `go`** — not a Monaco model. Diff-editor
   models (`diff-viewer.tsx:115`), peek-preview models (§3.3) and models kept alive after their tab
   closes (`code-viewer.tsx:160`) are never synced. Tab mount → `lsp:open`; tab close → `lsp:close`.
2. Host resolves the doc's **server key** (§2.3), starting a server lazily if none exists (the locked
   trigger: first Go tab open or first Go nav). The reply carries `{serverKey, state}`.
3. Buffer edits → `lsp:change` (full text, per-tab version, debounced 150 ms).
4. Nav on a model whose language **has a server** (a capability the host reports from its registry,
   §3.2 `statusSnapshot.languages`; the renderer never hard-codes `go`): `runNavCommand` takes the
   **LSP branch**, which sends `lsp:request` instead of probing the TS worker. The reply feeds `classifyNavOutcome`/`navOutcomeMessage`. One location → the existing
   editor-opener path (`openDefinitionFile` + reveal — the path feat/nav-history hooks; no parallel open
   path); many → Monaco's peek widget, as TS multi-result does.
5. Go copies TS's nav semantics: definition at the cursor itself falls through to references
   (`HAS_REFERENCE_ALTERNATIVE`); Alt+F12 peek = `definition` shown in the peek widget; references
   include the declaration.
6. Hover provider and breadcrumbs for `go` ask the host too (§3.2).

### 2.2 Server lifecycle (per server key)
| State | Entered when | Nav request | Hover / symbols |
|---|---|---|---|
| `absent` | resolution (§3.4) finds no gopls | outcome `lsp-missing` | empty, silent |
| `starting` | spawned, `initialize` unanswered | inline "{displayName}: loading workspace…"; the request is sent once `initialize` completes | wait ≤ 3 s for `initialize`, else empty |
| `loading` | initialized, a `$/progress` begin still open | sent immediately (gopls queues it itself — measured §2.5); inline loading message; 90 s budget. Progress tokens only pick the timeout, never gate the send | same (sent, 3 s) |
| `ready` | initialized, no open load progress | normal | normal |
| `restarting` | unexpected exit, budget left | same as `starting` | empty |
| `crashed` | exit with budget spent, or `initialize` failed | outcome `lsp-crashed` | empty |
| stopped | idle, palette restart, quit | next open/request starts it fresh | — |

- **Lifetime / idle stop:** a server lives while its root has **at least one open tab of that server's
  language in any window**. Sessions do not hold it (a terminal in the repo is not a reason to keep
  hundreds of MB of gopls). **60 s after the last such tab closes** → graceful stop. Any open/request
  cancels the timer. (ADR 0006 §Lifetime.)
- **Crash-restart:** restart after 1 s / 4 s / 16 s; ≤ **3 restarts per rolling 5 min**; then `crashed`.
  Each restart replays `didOpen` for every open doc from the host sync table **before** the state leaves
  `restarting`; a request arriving mid-replay waits for the replay. While a server is not live
  (`starting` before `initialize`, `restarting`, `absent`, `crashed`), open/change/close only update
  the sync table — replay sends the current text. Last 50 stderr lines per server go to the host log on
  every exit.
- **Ordered exits are not crashes:** an exit the host caused (idle stop, palette restart, re-home, quit)
  is flagged `stopping` on that server before the stop starts, and its exit never restarts. Quit sets a
  manager-wide `disposed` flag first, clears every restart and idle timer, and every async step
  (root/binary resolution) re-checks it before spawning — nothing is spawned during or after quit.
- **Absent:** the verdict is cached 30 s. The sync table keeps docs opened while absent; when a later
  re-probe finds gopls, the server starts and replays them — installing gopls needs no restart.
- **Manual recovery:** Conduit's command palette (`command-palette.tsx`, not Monaco's quickCommand)
  lists **"Restart {displayName} language server"** (for Go: "Restart Go language server") for each
  language that has a server entry in any state other than `stopped` (running, `absent` or `crashed`).
  It ships in the **same slice as the crash message** that names it. It stops every server of that
  language, clears budgets and the absent cache; the next open/request starts fresh.
- **Root markers change** (agent runs `go mod init`, adds/removes `go.work`): a watcher event for a
  marker inside a server root makes the host recompute keys for that root's open docs and re-home any
  that moved (`didClose` old, `didOpen` new; the old server follows the idle rule). A `go.work` created
  *above* a module root is not watched — picked up on reopen or palette restart (accepted, §12).

### 2.3 Server root and multi-root
- File inside workspace root `W` (a `writeRoots()` member): walk from its directory up to `W`. Root =
  the **highest `go.work` directory** on that path, else the **nearest `go.mod` directory**, else `W`
  (gopls ad-hoc mode; nav still works within a package). The root is `realpath`ed **only for the
  dedupe key**. gopls is given the root in the **doc-path spelling** (the lexical root first seen for
  that key), so doc URIs and the root URI agree under a junction/`subst`; any path gopls returns under
  the realpath root is mapped back onto the lexical root before it reaches the renderer.
- Canonical path rules (drive-letter case, separators) come from `canonicalPath`, which moves from
  `webview/project-index.ts` (imports monaco) into `src/` so host and renderer share it. One module
  reached from two sessions/windows → one server; two modules without `go.work` → two.
- **Go files outside every root** (GOROOT, module cache): attached to the server whose reply last named
  that file (host `path → serverKey` LRU of 2 000 — ample for a session's jump targets, bounded memory).
  No origin → outcome `lsp-no-root`.
- Servers are process-global; docs are ref-counted per **client** = `(webContents id, page-load
  epoch)`. The epoch is a nonce the preload mints once per page load and attaches to every `lsp`
  message, because a `webContents` id survives `reload()` (the renderer-crash recovery at
  `main.ts:1037` reloads in place). The first message carrying a new epoch for a `webContents` retires
  the previous epoch and drops all its refs; a straggler from a retired epoch is rejected. A destroyed
  `webContents` drops every epoch. The reloaded renderer re-sends `lsp:open` for its tabs and asks
  `lsp:statusSnapshot`.

### 2.4 Stop, quit, orphans
- **Graceful stop:** `shutdown` request; on its reply (or after 2 s) → **PID-scoped tree kill**
  directly. The `exit` notification is **not** sent: gopls would exit on it and orphan its `go list`
  children before the tree kill runs (`/T` cannot find them once the parent has exited).
  Windows: `execFile('%SystemRoot%\System32\taskkill.exe', ['/PID', pid, '/T', '/F'])`; POSIX: spawn
  `detached` (own process group; POSIX only) and `process.kill(-pid)`. Never by image name — the user's
  own editors run `gopls` too.
- **Quit:** `before-quit` is synchronous: for each live server, `execFileSync` the same tree kill (no
  shutdown round-trip; ~100–300 ms each, measured-at-build).
- **Main-process crash / force-kill (updater):** children are not reaped by us. v1 relies on gopls
  exiting when its stdin closes (**ASSUMED**, §13). This is **tested**, not assumed into the ship: an
  e2e force-kills only the Electron main process (`taskkill /PID <main> /F`, no `/T`) and asserts every
  recorded gopls PID and descendant is gone within 5 s. If it fails, a Windows Job object
  (kill-on-close) becomes in-scope for this build.

### 2.5 Current behavior
| Claim | How measured | Status |
|---|---|---|
| Go nav refused up front: `TS_LANGS` gate → `unsupported` | `ts-nav.ts:46,508` | Source read |
| Non-TS: nav menu rows disabled, Ctrl+click silent | `editor-menu.ts:158`, `code-viewer.tsx:384` | Source read |
| Breadcrumb symbols only from TS `getNavigationTree`; refetch on each cursor event while tree null | `breadcrumb-bar.tsx:71-110` | Source read |
| `readFile` IPC broadcasts `fileContent` into the tab map and records a write grant | `main.ts:2170-2177`, `app.tsx:334` | Source read |
| Toasts append (no dedupe); inline nav messages replace | `toast-store.ts:53`, `nav-outcome.ts` | Source read |
| No LSP client, no `vscode-jsonrpc` | `package.json`, `node_modules` | Measured |
| gopls v0.20.0 at `C:\Users\karam\go\bin\gopls.exe`; Go 1.25.3; `go env GOPATH`=`C:\Users\karam\go` | ran them | Measured |
| `initialize` ~0.3 s; "Loading packages…" progress lasts **~30 s cold / ~1.4 s warm** on a 3-file module | scratch stdio client, two runs | Measured |
| A `definition` sent mid-load is queued, answered right after load ends | same | Measured |
| Replies use `file:///C:/…` (upper-case drive) even when sent `file:///c:/…`; spaces `%20` | same | Measured |
| Definition within a package, across packages, into GOROOT (`builtin.go`); references incl. declaration; markdown hover with a `pkg.go.dev` link; hierarchical `DocumentSymbol` | same | Measured |
| gopls needs `workspace/didChangeWatchedFiles` to see unopened-file edits | gopls docs | **ASSUMED** |
| Hover links route to the external browser via `openExternal` | not driven | **ASSUMED** |

## 3. Data / interface contract

### 3.1 Server registry (host, code-defined — never read from a workspace)
```ts
interface LanguageServerSpec {
  languageId: string;            // Monaco id: 'go'
  displayName: string;           // 'Go'
  binary: string;                // bare name 'gopls', resolved by §3.4 — never a configured path
  args: readonly string[];       // []
  rootMarkers: { workspace: readonly string[]; module: readonly string[] }; // ['go.work'], ['go.mod']
  watchGlobs: readonly string[]; // ['**/*.go','**/go.mod','**/go.sum','**/go.work']
  installHint: string;           // 'go install golang.org/x/tools/gopls@latest'
  extraSearchDirs(): Promise<string[]>; // §3.4
  childEnv(base: NodeJS.ProcessEnv, resolvedGoDir: string | null): NodeJS.ProcessEnv; // §3.4
}
```
Exactly one entry (`go`) in v1, in a pure `src/` module so resolution, root rules and restart budget
unit-test in node on ubuntu CI. **Nothing downstream special-cases `go`:** the watcher's filter is
derived from `watchGlobs`; the renderer learns which languages have a server from
`statusSnapshot.languages` (`{languageId, displayName, binary, installHint, moduleMarker}` per
entry); every user-facing string is templated from those fields (§3.3); the palette entry is "Restart
{displayName} language server".

### 3.2 Renderer ↔ host protocol (`src/protocol.ts` + `window.agentDeck.lsp`)
**Ordering:** every message is an `ipcRenderer.invoke('lsp', msg)`. The host handler **enqueues
synchronously on arrival** (before any `await`) onto a **serial queue per server key**; the queue
forwards to gopls in arrival order. The renderer, before sending a nav request for a tab, sends that
tab's pending debounced `lsp:change` (flush), then the request — so the request follows its text.
**Hover flushes too** (≤ 150 ms of pending edit, so a hover never answers against text the user can't
see). Symbols do **not** flush; they carry the tab's last sent version and a reply whose version no
longer matches the tab is dropped. Every message travels as `{epoch, msg}` (§2.3).

| Message | Shape | Reply |
|---|---|---|
| `lsp:open` | `{path, languageId, version, text}` | `{serverKey, state}` |
| `lsp:change` | `{path, version, text}` | `{ok}` |
| `lsp:close` | `{path}` | `{ok}` |
| `lsp:request` | `{requestId, path, version, op, line, character}` — op `definition\|typeDefinition\|implementation\|references\|hover\|documentSymbol`; 0-based UTF-16 | `LspReply` |
| `lsp:cancel` | `{requestId}` → `$/cancelRequest` | `{ok}` |
| `lsp:statusSnapshot` | `{}` | `{servers: {serverKey, languageId, root, state, pid}[], languages: {languageId, displayName, binary, installHint, moduleMarker}[]}` |
| `lsp:restart` | `{languageId}` | `{ok}` |
| `lsp:status` (push, `to-webview`) | `{serverKey, languageId, root, state, progress?}` on every transition | — |

```ts
type LspReply =
  | { kind: 'locations'; locations: { path: string; range: Range }[];
      targets: { path: string; text: string }[] }   // text of each distinct target not open as a tab
  | { kind: 'hover'; markdown: string; range?: Range }
  | { kind: 'symbols'; tree: NavTreeNode }
  | { kind: 'empty'; adHocRoot: boolean }             // true when the root fell back to W (no go.mod)
  | { kind: 'stale' }                                  // version superseded — renderer drops it
  | { kind: 'unavailable'; reason: 'missing' | 'crashed' | 'no-root' | 'loading-timeout'
      | 'timeout' | 'server-error'; detail?: string }; // detail → host log only
```
- The host converts every URI to a canonical path; **the renderer never sees a server URI**.
  `Location` and `LocationLink` both accepted (target selection range preferred); non-`file:` dropped.
- `targets` are read by the host for the reply (≤ 200 files, ≤ 2 MB each; over → dropped and counted
  like TS's "targets we hold no content for"). This is **not** `readFile`: no `fileContent` broadcast, no
  write grant. Peek models built from them are tracked by the LSP branch and disposed when the
  next LSP nav starts or the editor is disposed (Monaco exposes no peek-close event). A single-result jump opens through the normal path (which does
  grant, as TS out-of-root targets do today — §13).
- `documentSymbol` → existing `NavTreeNode` (`src/breadcrumbs.ts`) host-side, offsets from the synced
  text, LSP `SymbolKind` → the TS kind strings the breadcrumb icons know (unknown → `''`).
- Same file open in two windows: the host keeps the latest text. A request is **current** when its
  version is that client's last accepted version **and** that client's last accepted text equals the
  host's current text — so two windows showing identical text are both answered, whichever wrote last.
  Only a window whose buffer has **diverged** from the host's text gets `stale` (rare, silent).

### 3.3 Nav outcomes (additions to `nav-outcome.ts`)
| Outcome | Channel / variant | Text |
|---|---|---|
| `lsp-loading` (interim) | inline / info | "{displayName}: loading workspace…" |
| `lsp-missing` | toast / info | "{displayName} navigation needs {binary} — install with `{installHint}`" |
| `lsp-crashed` | toast / error | "The {displayName} language server stopped. Run “Restart {displayName} language server” from the command palette." |
| `lsp-loading-timeout` | toast / info | "{binary} is still loading this workspace. Try again in a moment." |
| `lsp-no-root` | toast / info | "{displayName} navigation works for files inside an open project." |
| `none` with `adHocRoot` | as today's `none` | today's none text + " (no {moduleMarker} found for this file)" |

Templates are filled from the language's registry entry (§3.1), so for Go they read exactly
"Go navigation needs gopls — install with `go install golang.org/x/tools/gopls@latest`", "(no go.mod
found for this file)", and so on.
| `timed-out` (ready but hung) | existing | existing |
- A Go `none` never appends TS index status/cap notes (`nav-outcome.ts:146-160`).
- Toasts from these outcomes are **deduped by text while one is visible** (new, in the nav-message
  toast path) so repeated F12 can't stack them.
- Ctrl+click on Go while `absent`/`crashed`/no-root stays **silent** (as non-TS Ctrl+click is today);
  keyboard, menu and palette nav speak.
- **Stale results:** each LSP nav holds a token; a newer nav, a cursor move **to a position other than
  the nav's origin** (Ctrl+click's own `setPosition` happens before the nav starts and must not cancel
  it), a model change or a tab switch cancels it (`lsp:cancel`) and its late reply is ignored — a 90 s
  wait can never yank the caret. `lsp:cancel` works in both phases: while the host is still waiting for
  `initialize`, and after the request reached gopls (`$/cancelRequest`).

### 3.4 Binary resolution, spawn, security
- **Search:** each **absolute, non-empty** `PATH` entry (`gopls`, plus each `PATHEXT` ext on Windows),
  then `extraSearchDirs()`: `$GOBIN`, each `$GOPATH` entry `/bin`, `go env GOPATH`/`bin`,
  `os.homedir()/go/bin` (Finder-launched macOS apps get no shell PATH). `go` itself is resolved the same
  way plus `/usr/local/go/bin`, `/opt/homebrew/bin`, `C:\Program Files\Go\bin`, and run as
  `execFile(goAbs, ['env','GOPATH'], {cwd: os.tmpdir(), env: {...env, GOTOOLCHAIN:'local'}, timeout:
  5 s})` — never inside the workspace. First regular file wins, `realpath`ed.
- **Spawn:** `spawn(abs, args, {cwd: serverRoot, shell:false, windowsHide:true, stdio:'pipe',
  detached: posix})`. Env = `childEnv(host env)`: the resolved `go` dir prepended to `PATH` (gopls
  needs `go`), **non-absolute `PATH` entries stripped** (a `.` or relative entry would let gopls, whose
  cwd is the repo, run a repo-local `go`), and **`GOTOOLCHAIN=local` unless the user's own environment
  already sets `GOTOOLCHAIN`** — a repo's `toolchain` directive must not make opening a file download
  and run a toolchain (§13 high). Recorded in ADR 0006 §Trust.
- **No workspace-supplied command strings anywhere:** no `.conduit/*`, `.vscode/*`, `go.work` or env
  file can name or alter the binary, args or env. A repo influences gopls only as it influences `go`.
- No shell; no relative binary; `cwd` never outside the server root; `taskkill` by absolute path.

### 3.5 Paths ⇄ URIs (pure, platform-independent)
- `pathToFileUri`/`fileUriToPath` in `src/`, never reading `process.platform`. `G:\x`/`g:/x` →
  `file:///G:/x` (drive upper-cased, `\`→`/`, segments percent-encoded incl. `#` `%` space non-ASCII);
  POSIX `/x` → `file:///x`. Reverse accepts `file:///c%3A/…`, `file:///C:/…`, `file:///c:/…`, UNC
  `file://server/share/…` → `\\server\share\…`. Windows cases unit-tested on ubuntu CI.
- Doc paths are not realpath'd (tabs keep the as-opened path); a symlinked module may yield a second
  tab for one file — accepted v1.

### 3.6 Dependency
**`vscode-jsonrpc`** (stdio framing, ids, cancellation) + **`vscode-languageserver-protocol`** (types,
method constants): MIT, pure JS, maintained by the LSP authors, host bundle only, listed in
`dependencies` (fallow unlisted-deps gate). Rejected: hand-rolled framing (the 30-line scratch client
behind §2.5 already mishandles partial headers); `vscode-languageclient` (bound to the VS Code API).
Record as **ADR 0006 — host-side language servers** (host owns processes, §3.4 security rule, one
server per root, trust posture).

### 3.7 Producers / consumers
| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Go tab text/version | `file:` Go tabs → `lsp:open/change/close` | host sync table → gopls | Yes |
| Unopened-file disk changes (agents) | per-server recursive watcher, filter **derived from the spec's `watchGlobs`** (never a hard-coded Go list), ignores via `shouldIgnoreWatchPath`, 200 ms coalesce | gopls `didChangeWatchedFiles`; host root re-homing | Yes — `ProjectWatcher` is single-root and path-less, not reused. `replace => ../x` targets outside the root are not watched (accepted) |
| Open-file disk changes | existing reload-on-disk-change → model | `lsp:change` | Yes |
| Nav outcomes/messages | LSP branch of `runNavCommand` | `navOutcomeMessage`, toast path | Yes |
| `unsupported` copy | go-basics | non-Go languages only; Go uses §3.3 | Yes (seam named) |
| Breadcrumb symbols | host `documentSymbol` | `breadcrumb-bar.tsx` | Yes |
| Nav landing in another file | editor opener | tab store + nav history (feat/nav-history) | Producer yes; history is that item's — no parallel path |
| Server status | host lifecycle | loading message, palette entry visibility | Yes |

## 4. Edge cases & failure modes
| Condition | Expected |
|---|---|
| gopls missing everywhere | Nav → `lsp-missing` toast once per visible period; hover/breadcrumbs silent; editing unaffected |
| Cold start / huge repo | Inline loading message; nav waits ≤ **90 s** (measured cold 30 s on 3 files ×3 headroom) → `lsp-loading-timeout` |
| Ready but hung | Per-request timeout 10 s nav / 3 s hover / 5 s symbols (interactive budgets; gopls answers warm queries in ms) → `$/cancelRequest` + existing `timed-out` |
| Crash mid-request | Pending → `server-error` → `timed-out` message; restart per §2.2 |
| Request right after typing | Debounce flushed first (§3.2) — answer reflects the buffer |
| Agent edits an unopened `.go`/`go.mod` | Forwarded within ~200 ms; next nav sees it |
| File renamed/deleted while open | Tab rename/close paths send close/open; watcher reports delete |
| Same file in two windows | One server; ref-count 2; `didClose` when both close; both answered while their text matches the host's (§3.2) |
| Renderer reloaded in place (crash recovery) | New epoch retires the old one's refs; the reloaded page re-opens its tabs and is answered normally |
| Quit while a root resolution / restart is pending | Nothing spawns (`disposed`); pending restart and idle timers cleared |
| Electron main force-killed | gopls and descendants gone within 5 s (e2e); else Job object in scope |
| Target file unreadable / non-`file:` | Dropped from the result, counted |
| Very large generated `.go` | Synced in full (structured clone per 150 ms debounce) — accepted v1, no cap |
| `go.mod`/`go.work`/`go.sum` tab | Not `go` → never synced, never starts a server |
| gopls → client requests (`workspace/configuration`, `window/workDoneProgress/create`, `client/registerCapability`) | Empty success; unknown → `MethodNotFound` |
| `window/showMessage`, `logMessage`, `publishDiagnostics` | Host log / dropped; never a toast |
| Breadcrumbs while not ready | Path crumbs only; Go refetches symbols on tab open, on `ready`, and 500 ms after the last edit — **never per cursor event** |

## 5. Defaults vs. settings
| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Go servers enabled | On when gopls resolves | No | Absent binary is the off switch; toggle if asked |
| Binary location | §3.4 search order | No | User-level path setting is a follow-up; never workspace-level |
| `GOTOOLCHAIN` | `local` unless user env sets it | No | Opening a file must not download/run code chosen by the repo |
| Idle grace | 60 s after the root's last server-language tab closes; sessions don't hold a server | No | Tab-switch thrash vs memory; gopls on a big repo is 100s of MB |
| Restart budget | 3 / 5 min, 1-4-16 s | No | Bounded; manual restart exists |
| Absent re-probe | 30 s | No | Cheap stat walk; install-without-restart |
| Text sync | Full, 150 ms debounce | No | Keystroke-rate IPC without perceptible lag; incremental is an optimisation |
| Capabilities advertised | the six v1 ops, markdown hover, hierarchical symbols, workDoneProgress, static didChangeWatchedFiles | — | Only what v1 consumes; gopls type-checks (and publishes diagnostics) regardless, which the host drops |

## 6. Scope slicing
- **MVP:** registry, resolution, spawn/security, lifecycle/restart, stop/quit; tab-keyed sync with the
  serial queue; definition / type definition / implementation / references via `runNavCommand`;
  §3.3 outcomes; menu + Ctrl+click enabled for languages with a server; palette restart (the crash
  message's instruction must exist the moment the message can appear).
- **v1 (this spec):** + hover, breadcrumbs, watcher, ADR 0006.
- **Vision:** diagnostics markers, completion, rename, user-level binary setting, more servers through
  the registry, a persistent server-status chip; a Windows Job object (pulled into v1 if the
  force-kill e2e fails, §2.4).

## 7. Acceptance criteria

### 7.1 EARS
- **E1** When a Go tab opens in any window, the host shall start or reuse exactly one gopls per server
  root and send it `didOpen`.
- **E2** When the user invokes Definition / Type Definition / Implementation / References / Peek on a Go
  model, the system shall answer from gopls through the same surfaces as TS navigation.
- **E3** When a definition has one location in another file, the system shall open it via the editor
  opener and reveal the range.
- **E4** While the doc's server is `starting`/`loading`/`restarting`, a nav request shall show "Go:
  loading workspace…" and complete when gopls answers, or report `lsp-loading-timeout` after 90 s.
- **E5** If gopls cannot be resolved, a nav request shall show the install message, and open, edit,
  save, hover and breadcrumbs shall show no error.
- **E6** If gopls exits unexpectedly, the host shall restart it ≤ 3 times in 5 min replaying open docs,
  then report `crashed` until "Restart Go language server".
- **E7** When the app quits — or its main process is force-killed — no gopls Conduit spawned, nor any
  of its descendants, shall be alive 5 s after the app exits; and no server shall be spawned or
  restarted once quit has begun.
- **E8** When a root has had no open tab of its server's language in any window for 60 s, the host
  shall stop its server. Open sessions do not keep it alive.
- **E13** When a renderer reloads in place, its open tabs shall be synced and answered again (no
  permanently dead sync), and refs from the pre-reload page shall be released.
- **E14** When the same file is open in two windows with identical text, navigation shall work in both.
- **E9** The host shall spawn only registry servers, by absolute resolved path, no shell, `cwd` = root,
  with `GOTOOLCHAIN=local` unless the user's env sets it.
- **E10** While the caret is inside a Go function, the breadcrumb bar shall show its enclosing chain.
- **E11** When an unopened Go file under a root changes on disk, the next nav shall reflect it.
- **E12** If the user moves the caret, switches tab or starts another nav before a Go nav resolves,
  that nav shall neither move the caret nor open a tab.
- E1 (sharing), E6, E7 (no spawn after quit), E8, E9, E12, E13, E14 are proven by unit tests with a
  fake server process and fake clock; the rest by the e2e below plus unit tests.

### 7.2 Gherkin (`test/e2e/go-lsp.e2e.mjs`, hidden, real gopls)
```gherkin
Background:
  Given a temp Go module "example.com/fix" with main.go and helper.go (package main)
    and pkg/util/util.go (package util; func Greet with doc comment "Greet says hi.")
  And the module is opened as a session with main.go open
  And the test waits for lsp:status "ready" for that root (ceiling 120 s; cold load measured 30 s)

Scenario: definition across files in one package
  When the user presses F12 on "helper" in main.go
  Then helper.go is the active tab with the caret on "func helper"

Scenario: definition across packages
  When the user Ctrl+clicks "Greet" in main.go
  Then pkg/util/util.go is the active tab with the caret on "Greet"

Scenario: references
  When the user runs Find References on "helper" in helper.go
  Then the references peek lists 2 results: helper.go and main.go

Scenario: hover
  When the user hovers "Greet" in main.go
  Then a hover shows "func util.Greet() string" and "Greet says hi."

Scenario: breadcrumbs
  When the caret is inside func main in main.go
  Then the breadcrumb bar ends with the symbol "main"

Scenario: agent edits an unopened file
  Given helper.go is not open in any tab
  When helper.go is rewritten on disk to declare "helper2" and main.go's buffer is edited to call helper2
  Then within 5 s (polled) F12 on "helper2" in main.go lands in helper.go

Scenario: gopls missing
  Given the app is launched (harness env) with PATH, GOBIN, GOPATH stripped of every gopls/go dir
    and HOME/USERPROFILE pointed at an empty temp dir
  When the user presses F12 on "helper" in main.go
  Then the install message is shown once, no other error toast appears, and main.go stays editable

Scenario: no orphans
  Given gopls is running for the fixture
  And the test records its PID (from lsp:statusSnapshot) and every descendant PID
    (ParentProcessId walk) before closing
  When the app is closed with closeApp
  Then none of the recorded PIDs is alive within 5 s

Scenario: no orphans after the main process is force-killed
  Given gopls is running for the fixture and its PID + descendants are recorded
  When only the Electron main process is killed with "taskkill /PID <main> /F" (no /T)
  Then none of the recorded PIDs is alive within 5 s
  (If this fails, a Windows Job object becomes in-scope for this build — §2.4.)

Scenario: palette restart
  Given gopls is running for the fixture
  When the user runs "Restart Go language server" from the command palette
  Then a "stopped" status is observed and a later F12 still navigates
```
Machine note: the "missing" scenario must not rely on Program Files paths being absent — it passes
only if §3.4's fixed dirs are also hidden or empty on the test machine; the plan decides the mechanism.

## 8. State catalog (UI touchpoints)
| Component | State | User sees | Action |
|---|---|---|---|
| Nav message | loading / missing / crashed / loading-timeout / no-root | §3.3 text | none / install / palette / retry / — |
| Hover | not ready or empty | no widget | — |
| Breadcrumbs | not ready / no symbols | path crumbs only | — |
| Context menu nav group | tab whose language has a server | enabled (TS parity) | — |
| Command palette | a server entry for the language exists / absent / crashed | "Restart {displayName} language server" | `lsp:restart` |

## 9. Interaction inventory
No new gestures: F12, Ctrl+F12, Shift+F12, Alt+F12, Shift+Alt+F12, Ctrl+click, context-menu nav group,
Monaco quickCommand entries, Conduit palette entry. Hover is Monaco's (mouse; `Ctrl+K Ctrl+I`).

## 10. Accessibility & i18n
- Messages reuse the inline/toast surfaces and their announcement behaviour; peek/hover are Monaco's
  widgets. No colour-only signal, no new focus management.
- English-only app; each message is one whole sentence template in `nav-outcome.ts`, filled once from
  the registry entry; "gopls", "go.mod" and the install command arrive as literal field values.

## 11. Design tokens
No new visual surface; hover markdown and peek use Monaco theme rules already mapped per theme.

## 12. Assumptions
- go-basics lands first or alongside. Status is surfaced only at nav time (no persistent chip).
- Diagnostics stay out: not free (markers, lifetimes, a Problems story).
- A `go.work` created above an existing module root is noticed only on reopen/restart.
- Cross-window **diverged** dirty buffers yield a silent `stale` for the diverged window only (rare).

## 13. Decisions Needed
- [high] **Trust:** opening a Go file in an untrusted clone auto-starts gopls, which runs `go list`
  (cgo `pkg-config`, repo `toolchain` directive). **Ruled (conductor):** keep lazy auto-start,
  mitigated by `GOTOOLCHAIN=local`, non-absolute `PATH` entries stripped from the child env, and no
  workspace config. The per-root opt-in on first Go nav is recorded in ADR 0006 as the alternative;
  the branch does not land on main without the user's decision.
- [high] **ADR 0006** written in this build, status "proposed" (ruled). It records trust (incl. the
  PATH strip), lifetime (tabs only, not sessions), and the Job-object contingency.
- [normal] Crash recovery surface: palette command (default) vs automatic cool-down retry.
- [normal] ASSUMED: gopls needs `didChangeWatchedFiles` — QA's agent-edit scenario confirms; if not,
  the watcher can go (root re-homing would then need its own trigger).
- [normal] ASSUMED: gopls exits on stdin EOF after a main-process crash — now proven or disproven by
  the force-kill e2e; a failure makes the Job object in-scope.
- [normal] Out-of-root targets (GOROOT, module cache) open as normal writable tabs, as TS out-of-root
  targets do today (default) vs read-only tabs.
- [normal] Idle 60 s / loading wait 90 s are from one measured machine.
- [normal] ASSUMED: hover links open externally via the existing path — verify in QA.

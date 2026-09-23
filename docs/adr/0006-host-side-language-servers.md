# ADR 0006 — Host-side language servers

**Status:** accepted · **Date:** 2026-09-22 (Workspace Trust: 2026-09-23)
**Spec:** `docs/specs/2026-09-22-language-server-go.md`, `docs/specs/2026-09-23-workspace-trust.md` · **Plan:** `docs/plans/2026-09-22-language-server-go.plan.md`

## Context

Code navigation in Conduit came from one place: Monaco's TypeScript worker, running in the
renderer against an index of the project's sources. Every other language got an honest
"Code navigation isn't available for … files" and nothing else. An external user asked for Go.

Go navigation can't come from the renderer. The only credible engine is `gopls`, a native
process the user installs, which loads a whole module with `go list`, answers LSP over stdio, and
can hold hundreds of MB. Something has to find it, start it, feed it the open buffers, stop it,
and make sure it never outlives the app. The renderer holds no source of truth and can be
reloaded in place (the crash recovery at `electron/main.ts` reloads without a new webContents),
so that something is the Electron host.

## Decision

**The host owns every language-server process.** `electron/lsp-manager.ts` holds the servers,
the synced-document table, the clients and the whole lifecycle; `electron/lsp-server.ts` is one
process and its JSON-RPC connection; the renderer is a thin client over one invoke channel,
`'lsp'`, whose messages are validated at the boundary (`src/lsp-protocol.ts`). The renderer
never sees a server URI — the host converts every one to a canonical path.

**One server per server root.** The root is the highest `go.work` directory above the file,
else the nearest `go.mod`, else the workspace root (gopls ad-hoc mode). The root's `realpath` is
**only** the dedupe key: gopls is handed the root in the doc-path spelling first seen for it, so
its root URI and the doc URIs agree under a junction or `subst`, and any path it returns under
the real root is mapped back onto that spelling before the renderer sees it.

**A code-defined registry, generic downstream.** `src/lsp-registry.ts` is the only file that
knows Go. The watcher's filter is compiled from the entry's `watchGlobs`; the renderer learns
which languages have a server from the host (`statusSnapshot.languages`); every user-facing
string is a template filled from the entry (`displayName`, `binary`, `installHint`,
`moduleMarker`). Adding a server is adding an entry.

**Client epochs.** Documents are ref-counted per client = `(webContents id, page-load epoch)`.
The preload mints the epoch once per page load, because a webContents id survives `reload()`.
The first message carrying a new epoch retires the old one and releases its documents; a
straggler from a retired epoch is rejected.

**Ordered stops are not crashes.** Every stop the host causes — idle, the palette restart, a
root re-home, quit — marks the server `stopping` first, and its exit never triggers a restart.
Quit sets a manager-wide `disposed` flag before anything else, clears every timer, and every
async step re-checks it before spawning. An unexpected exit restarts after 1 s / 4 s / 16 s, at
most three times in a rolling five minutes, replaying every open document before any request
is sent; after that the server is `crashed` until the palette's "Restart {displayName} language
server". A graceful stop is `shutdown` then a PID-scoped tree kill — never the `exit`
notification, which would let gopls exit and orphan its `go list` children before `/T` can find
them. Nothing is ever killed by image name.

## Trust

Opening a Go file in a clone starts gopls, and gopls runs `go list` — which honours a repo's
`toolchain` directive and cgo's `pkg-config`. The user's decision ("how does VSCode handle this?
DO THAT!") is **VS Code's Workspace Trust, adapted** — spec
`docs/specs/2026-09-23-workspace-trust.md`:

- **Per-folder trust, stored in userData** (`workspace-trust.json`), never in a repo, keyed by
  canonical path (case-insensitive on Windows). Trusting a folder trusts everything under it, so
  "Trust Parent Folder" covers every sibling project at once.
- **Restricted Mode for an untrusted folder: no language server starts.** Editing and
  highlighting are unaffected. Nav, hover and the breadcrumb bar say "Restricted Mode: trust this
  folder to enable {language} navigation", with a way to raise the prompt.
- **When it asks:** VS Code asks when a folder opens. Conduit opens a folder per terminal session
  and gopls is the only thing that runs project code, so it asks the first time a language server
  would start for a folder with no decision — after the binary resolves (a missing gopls is no
  trust question). The prompt is non-modal and in the editor area: Trust / Trust Parent Folder /
  Don't Trust. Don't Trust holds for the app session; the palette's Trust Current Folder asks
  again.
- **Revoking** (palette: Manage Workspace Trust) stops that folder's servers through the ordered
  stop — the PID-scoped tree kill — and leaves them Restricted.
- **The host owns the decision.** The store, the prompts and the enforcement live in the main
  process (`LspManager`, checked before every spawn). The renderer can ask the host to raise a
  prompt for a path (refused outside every workspace root), answer a prompt the host raised — by
  its host-minted id and a choice enum, never a path — and revoke. It can never name a folder to
  trust. **Accepted floor — stated plainly:** a compromised renderer needs no user action to trust
  a folder. It can make the host raise a prompt (`lsp:trustRequest`), read the prompt's id
  (`lsp:trustState`, or the `lsp:trust` push) and answer it, which trusts any workspace root — or
  that root's parent, within the parent bound below. The host-owned flow only guarantees that
  the renderer cannot reach a folder outside the open workspaces. This is accepted because the
  gate defends a different threat: **opening an untrusted clone must not auto-run its tools**. A
  compromised renderer is already game over — it drives the PTYs and so runs any command as the
  user — so a trust flow that resists it would add no protection. Closing it would need a
  host-drawn native dialog, which the e2e suite cannot drive.
- **"Trust Parent Folder" is bounded.** It is never offered — and the host refuses it — when the
  parent is a filesystem root (`G:\`, `/`) or the user's home directory; the button names the
  folder it would trust.

Within a trusted folder the earlier mitigations still hold:

- **Lazy start**: the first Go tab, or the first Go navigation, starts the server.
- **`GOTOOLCHAIN=local`** in the server's environment unless the user's own environment sets
  `GOTOOLCHAIN` — opening a file must not download and run a toolchain the repo chose.
- **Non-absolute `PATH` entries are stripped from the server's environment.** The server's cwd
  is the repo, so a `.` or relative entry would let it run a repo-local `go`. The same rule
  governs the binary search itself.
- **No workspace-supplied configuration of any kind**: no `.conduit/*`, `.vscode/*`, `go.work`
  or env file can name or alter the binary, its arguments or its environment. The binary is found
  by name on `PATH` and a fixed list of well-known directories, `realpath`'d, and spawned by
  absolute path with no shell. A repo influences gopls only as it influences `go`.
- **The rest of the host environment passes through unchanged.** Apart from the PATH strip and
  the `GOTOOLCHAIN` default, gopls inherits Conduit's environment — including anything the user
  set for Go themselves. That is deliberate (it is their toolchain configuration), but it means
  the user's own settings widen what opening a file can do: `GOFLAGS=-mod=mod`, for example, lets
  `go list` rewrite `go.mod`/`go.sum` and fetch modules, and `GOPROXY`/`GOPRIVATE`/`GONOSUMDB`
  decide where from. Conduit does not override them.

**Rejected:** unconditional lazy auto-start (the first draft of this ADR) — it runs a fresh
clone's `go list` without asking. A per-root yes/no with no inheritance — Workspace Trust's
parent-folder rule gives the same safety with one answer for a whole projects directory.

## Lifetime

A server lives while its root has at least one open tab of its language in any window. Sessions
do **not** hold a server: a terminal in a repo is no reason to keep hundreds of MB of gopls
alive. Sixty seconds after the last such tab closes the server is stopped gracefully; any open
or request in that window cancels the stop.

## Consequences

- **Orphans after a main-process crash rely on stdin EOF.** A force-killed Electron main cannot
  run `before-quit`, so gopls is left to notice its stdin closing. This is proven, not assumed:
  the `go-lsp` e2e force-kills only the main process (`taskkill /PID <main> /F`, no `/T`) and
  asserts gopls and every descendant are gone within 5 s. If that ever fails, a Windows Job
  object with kill-on-close becomes necessary — which needs a native binding the tree does not
  have (`@lydell/node-pty` exposes none).
- **Diagnostics are not free.** gopls type-checks and publishes diagnostics regardless; the host
  drops them. Showing them is a separate feature (markers, lifetimes, a Problems story).
- Two more dependencies ship in the main bundle: `vscode-jsonrpc` and
  `vscode-languageserver-protocol` (bundled by esbuild; `node_modules` is not packaged).

## Alternatives rejected

- **Hand-rolled LSP framing.** The 30-line scratch client used to measure gopls already
  mishandled partial `Content-Length` headers; stdio framing, ids and cancellation are the
  library's job.
- **`vscode-languageclient`.** It is bound to the VS Code extension API; everything it adds on
  top of `vscode-jsonrpc` assumes that host.
